import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  commerceDbScope,
  type CommerceScope,
} from '../commerce/types/commerce-scope';

@Injectable()
export class ProductCommandService {
  constructor(private readonly prisma: PrismaService) {}

  async execute<T>(
    scopeInput: CommerceScope,
    actorAdminId: string,
    requestId: string,
    action: string,
    input: unknown,
    mutate: (tx: Prisma.TransactionClient, commandId: string) => Promise<T>,
  ): Promise<T> {
    // Retain tenantId:null in the durable fingerprint so earlier commands replay.
    const scope = commerceDbScope(scopeInput);
    const fingerprint = createHash('sha256')
      .update(canonicalJson({ action, input, scope }))
      .digest('hex');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const actor = await tx.adminMember.findFirst({
          where: {
            id: actorAdminId,
            OR: [{ companyId: scope.companyId }, { companyId: null }],
          },
          select: { id: true },
        });
        if (!actor)
          throw new ForbiddenException(
            'Catalog actor does not administer this company',
          );
        // Serialize the durable operation key across processes before checking its stored outcome.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`catalog:${scope.companyId}:${requestId}`}, 0))`;
        const existing = await tx.productCatalogCommand.findUnique({
          where: {
            companyId_requestId: { companyId: scope.companyId, requestId },
          },
        });
        if (existing) {
          if (
            existing.tenantId !== scope.tenantId ||
            existing.fingerprint !== fingerprint
          ) {
            throw new ConflictException(
              'Request ID was already used for a different catalog command',
            );
          }
          return existing.result as T;
        }
        const command = await tx.productCatalogCommand.create({
          data: {
            ...scope,
            actorAdminId,
            requestId,
            action,
            fingerprint,
            result: {},
          },
        });
        const result = await mutate(tx, command.id);
        // Only public catalog data is persisted; Decimal and Date fields are serialized by the caller.
        const stored = JSON.parse(
          JSON.stringify(result),
        ) as Prisma.InputJsonValue;
        await tx.productCatalogCommand.update({
          where: {
            id: command.id,
            companyId: scope.companyId,
            tenantId: scope.tenantId,
          },
          data: { result: stored },
        });
        return stored as T;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Product or variant SKU already exists in this company',
        );
      }
      throw error;
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}
