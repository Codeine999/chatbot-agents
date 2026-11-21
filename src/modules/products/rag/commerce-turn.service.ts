import {
  Injectable,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type CommerceTurn } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { UsersAiProviderService } from '../../ai/users-ai-provider.service';
import { AiBudgetService } from '../../usage/rate-limit/ai-budget.service';
import { rethrowPendingAiUsage } from '../../usage/billing/pending-ai-usage.error';
import { rethrowInsufficientCredit } from '../../usage/credit-point/insufficient-credit.exception';
import {
  isAiProviderName,
  type AiGenerateRequest,
  type AiGenerateResponse,
} from '../../../ai-provider/types/ai-provider.types';
import type { LineAiUsageContext } from '../../usage/billing/ai-usage.types';
import {
  commerceDbScope,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import {
  ownerColumns,
  turnBelongsTo,
  type CommerceOwner,
} from './commerce-owner';

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
    owner: CommerceOwner,
    turnId: string,
  ): Promise<CommerceTurn | null> {
    const partition = commerceDbScope(scope);

    const existing = await this.prisma.commerceTurn.findUnique({
      where: {
        companyId_connectionKey_externalEventId: {
          companyId: scope.companyId,
          connectionKey,
          externalEventId: turnId,
        },
      },
    });
    if (
      existing &&
      (existing.tenantId !== partition.tenantId ||
        !turnBelongsTo(existing, owner))
    )
      throw new ForbiddenException('Product turn ownership mismatch');

    return existing;
  }

  /** The conversation exists and belongs to this person, in this company. */
  private async ownsConversation(
    scope: CommerceScope,
    owner: CommerceOwner,
  ): Promise<boolean> {
    const partition = commerceDbScope(scope);
    // A contact that signed up as a customer must still be an active one.
    const customerOk: Prisma.CustomerWhereInput = {
      ...partition,
      status: 'ACTIVE',
    };
    if (owner.kind === 'PREVIEW') {
      // Only a back-office admin of this company (or a legacy company-less one
      // in a single-company deployment) may have a preview session.
      const admin = await this.prisma.adminMember.findFirst({
        where: {
          id: owner.adminMemberId,
          OR: [{ companyId: scope.companyId }, { companyId: null }],
        },
        select: { id: true },
      });
      return Boolean(admin);
    }
    if (owner.kind === 'LINE') {
      const thread = await this.prisma.lineConversation.findFirst({
        where: {
          id: owner.conversationId,
          lineMemberId: owner.lineMemberId,
          lineMember: {
            lineUserId: owner.userId,
            OR: [{ customerId: null }, { customer: customerOk }],
          },
        },
        select: { id: true },
      });
      return Boolean(thread);
    }
    const room = await this.prisma.channelConversation.findFirst({
      where: {
        id: owner.conversationId,
        companyId: scope.companyId,
        channel: owner.channel,
        contactId: owner.contactId,
        contact: {
          companyId: scope.companyId,
          OR: [{ customerId: null }, { customer: customerOk }],
        },
      },
      select: { id: true },
    });
    return Boolean(room);
  }

  async open(
    scope: CommerceScope,
    connectionKey: string,
    owner: CommerceOwner,
    turnId: string,
    input: unknown,
  ) {
    const partition = commerceDbScope(scope);
    if (!(await this.ownsConversation(scope, owner)))
      throw new ForbiddenException('Product conversation ownership mismatch');
    const key = {
      companyId: scope.companyId,
      connectionKey,
      externalEventId: turnId,
    };
    const existing = await this.prisma.commerceTurn.findUnique({
      where: { companyId_connectionKey_externalEventId: key },
    });
    if (existing) {
      if (
        existing.tenantId !== partition.tenantId ||
        !turnBelongsTo(existing, owner)
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
        ...ownerColumns(owner),
        ...selection,
        input: commerceJson(input),
      },
    });
    if (turn.tenantId !== partition.tenantId || !turnBelongsTo(turn, owner))
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
          // Usage rows carry whichever conversation id the turn has; neither
          // column is a foreign key, so a channel room id is recorded as is.
          lineMemberId: lease.turn.lineMemberId ?? undefined,
          conversationId:
            lease.turn.conversationId ??
            lease.turn.channelConversationId ??
            undefined,
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
      // Nothing was reserved or sent; leave the slot retryable once the wallet is funded.
      rethrowInsufficientCredit(error);
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
