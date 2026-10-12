import {
  Injectable,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type CommerceTurn } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersAiProviderService } from '../ai/users-ai-provider.service';
import { AiBudgetService } from '../usage/rate-limit/ai-budget.service';
import { rethrowPendingAiUsage } from '../usage/billing/pending-ai-usage.error';
import {
  isAiProviderName,
  type AiGenerateRequest,
  type AiGenerateResponse,
} from '../../ai-provider/types/ai-provider.types';
import type { LineAiUsageContext } from '../usage/billing/ai-usage.types';
import { commerceDbScope, type CommerceScope } from './types/commerce-scope';

export const commerceJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export type CommerceLease = {
  turn: CommerceTurn;
  owner: string;
  scope: CommerceScope;
};

/** Short DB leases fence stages. Provider calls run after the DB transaction commits. */
@Injectable()
export class CommerceTurnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: UsersAiProviderService,
    private readonly budget: AiBudgetService,
  ) {}

  /** A replayed event must keep its first routing decision; this never creates a turn. */
  async find(
    scope: CommerceScope,
    connectionKey: string,
    context: LineAiUsageContext,
  ): Promise<CommerceTurn | null> {
    const partition = commerceDbScope(scope);
    if (!context.turnId) return null;
    const existing = await this.prisma.commerceTurn.findUnique({
      where: {
        companyId_connectionKey_externalEventId: {
          companyId: scope.companyId,
          connectionKey,
          externalEventId: context.turnId,
        },
      },
    });
    if (
      existing &&
      (existing.tenantId !== partition.tenantId ||
        existing.lineMemberId !== context.lineMemberId ||
        existing.conversationId !== context.conversationId)
    )
      throw new ForbiddenException('Product turn ownership mismatch');
    return existing;
  }

  async open(
    scope: CommerceScope,
    connectionKey: string,
    context: LineAiUsageContext,
    input: unknown,
  ) {
    const partition = commerceDbScope(scope);
    if (
      !context.turnId ||
      !context.lineMemberId ||
      !context.conversationId ||
      !context.userId
    )
      throw new ForbiddenException(
        'Product turns require a verified channel event',
      );
    const thread = await this.prisma.lineConversation.findFirst({
      where: {
        id: context.conversationId,
        lineMemberId: context.lineMemberId,
        lineMember: {
          lineUserId: context.userId,
          OR: [
            { customerId: null },
            { customer: { ...partition, status: 'ACTIVE' } },
          ],
        },
      },
      select: { id: true },
    });
    if (!thread)
      throw new ForbiddenException('Product conversation ownership mismatch');
    const key = {
      companyId: scope.companyId,
      connectionKey,
      externalEventId: context.turnId,
    };
    const existing = await this.prisma.commerceTurn.findUnique({
      where: { companyId_connectionKey_externalEventId: key },
    });
    if (existing) {
      if (
        existing.tenantId !== partition.tenantId ||
        existing.lineMemberId !== context.lineMemberId ||
        existing.conversationId !== context.conversationId
      )
        throw new ForbiddenException('Product turn ownership mismatch');
      return existing;
    }
    const selection = await this.providers.selection();
    const turn = await this.prisma.commerceTurn.upsert({
      where: { companyId_connectionKey_externalEventId: key },
      update: {},
      create: {
        ...partition,
        ...key,
        lineMemberId: context.lineMemberId,
        conversationId: context.conversationId,
        ...selection,
        input: commerceJson(input),
      },
    });
    if (
      turn.lineMemberId !== context.lineMemberId ||
      turn.conversationId !== context.conversationId ||
      turn.tenantId !== partition.tenantId
    )
      throw new ForbiddenException('Product turn ownership mismatch');
    return turn;
  }

  async withLease<T>(
    scope: CommerceScope,
    id: string,
    work: (lease: CommerceLease) => Promise<T>,
  ): Promise<T> {
    const partition = commerceDbScope(scope);
    const owner = randomUUID();
    const claimed = await this.prisma.commerceTurn.updateMany({
      where: {
        id,
        ...partition,
        OR: [{ leaseOwner: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 180000) },
    });
    if (!claimed.count)
      throw new ServiceUnavailableException(
        'Product turn is processing; retry the same event',
      );
    const heartbeat = setInterval(() => {
      void this.prisma.commerceTurn
        .updateMany({
          where: { id, ...partition, leaseOwner: owner },
          data: { leaseUntil: new Date(Date.now() + 180000) },
        })
        .catch(() => undefined);
    }, 30000);
    heartbeat.unref();
    try {
      const turn = await this.prisma.commerceTurn.findFirstOrThrow({
        where: { id, ...partition, leaseOwner: owner },
      });
      return await work({ turn, owner, scope });
    } finally {
      clearInterval(heartbeat);
      await this.prisma.commerceTurn.updateMany({
        where: { id, ...partition, leaseOwner: owner },
        data: { leaseOwner: null, leaseUntil: null },
      });
    }
  }

  async save(
    lease: CommerceLease,
    field: 'plan' | 'retrieval' | 'response',
    value: unknown,
  ) {
    const written = await this.prisma.commerceTurn.updateMany({
      where: {
        id: lease.turn.id,
        ...commerceDbScope(lease.scope),
        leaseOwner: lease.owner,
      },
      data: { [field]: commerceJson(value) },
    });
    if (!written.count)
      throw new ServiceUnavailableException('Product turn lease lost');
  }

  async call(
    lease: CommerceLease,
    slot: 'PLAN' | 'ANSWER' | 'CRITICAL_REPAIR',
    request: AiGenerateRequest,
    context: LineAiUsageContext,
    critical = false,
  ): Promise<AiGenerateResponse | undefined> {
    const partition = commerceDbScope(lease.scope);
    const operation = await this.prisma.$transaction(async (tx) => {
      const owned = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "commerceTurns" WHERE id=${lease.turn.id}::uuid AND "companyId"=${partition.companyId}::uuid
          AND "tenantId" IS NULL AND "leaseOwner"=${lease.owner}::uuid FOR UPDATE`;
      if (!owned.length)
        throw new ServiceUnavailableException('Product turn lease lost');
      const existing = await tx.commerceLlmCall.findUnique({
        where: { turnId_slot: { turnId: lease.turn.id, slot } },
      });
      if (existing) return existing;
      const count = await tx.commerceLlmCall.count({
        where: { turnId: lease.turn.id },
      });
      if (
        count >= 3 ||
        (slot === 'CRITICAL_REPAIR' && !critical) ||
        (count === 2 && slot !== 'CRITICAL_REPAIR')
      )
        return undefined;
      return tx.commerceLlmCall.create({
        data: {
          turnId: lease.turn.id,
          slot,
          ordinal: count + 1,
          request: commerceJson(request),
        },
      });
    });
    if (!operation || operation.failed) return undefined;
    if (operation.result)
      return operation.result as unknown as AiGenerateResponse;
    if (!isAiProviderName(lease.turn.provider))
      throw new Error('Invalid pinned product provider');
    let result: AiGenerateResponse;
    try {
      result = await this.providers.generate(
        operation.request as unknown as AiGenerateRequest,
        {
          ...context,
          lineMemberId: lease.turn.lineMemberId,
          conversationId: lease.turn.conversationId,
          turnId: lease.turn.externalEventId,
        },
        {
          provider: lease.turn.provider,
          model: lease.turn.model,
          operationKey: `usage:product:${lease.turn.id}:${slot}`,
          beforeCall: async () => {
            if (!(await this.budget.tryConsume(context.userId)))
              throw new ServiceUnavailableException(
                'Product AI budget exceeded',
              );
          },
        },
      );
    } catch (error) {
      rethrowPendingAiUsage(error);
      // Do not mark a DB persistence failure as provider failure: billing replay recovers on retry.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError ||
        error instanceof Prisma.PrismaClientUnknownRequestError
      )
        throw error;
      await this.prisma.commerceLlmCall.update({
        where: { id: operation.id },
        data: { failed: true },
      });
      return undefined;
    }
    // Billing has settled the replayable result already; local persistence failures must propagate for replay.
    await this.prisma.commerceLlmCall.update({
      where: { id: operation.id },
      data: { result: commerceJson(result) },
    });
    return result;
  }
}
