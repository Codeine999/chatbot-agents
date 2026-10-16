import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Customer } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  scoped,
  commerceDbScope,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import {
  verifiedChannelIdentitySchema,
  type VerifiedChannelIdentity,
} from './types/channel-identity';

@Injectable()
export class CustomerIdentityService {
  constructor(private readonly prisma: PrismaService) {}

  resolveOrCreate(scope: CommerceScope, identity: VerifiedChannelIdentity) {
    return this.prisma.$transaction((tx) =>
      this.resolveInTransaction(tx, scope, identity),
    );
  }

  /** Internal composition point for registration/link transactions; no network/provider work. */
  async resolveInTransaction(
    tx: Prisma.TransactionClient,
    scopeInput: CommerceScope,
    identityInput: VerifiedChannelIdentity,
    bindCustomerId?: string,
  ) {
    const scope = scoped(scopeInput);
    const partition = commerceDbScope(scope);
    const identity = verifiedChannelIdentitySchema.parse(identityInput);
    await this.lockIdentity(tx, scope, identity);
    const namespace = { companyId: scope.companyId, ...identity };
    let line:
      | { id: string; customerId: string | null; memberId: string | null }
      | undefined;
    if (identity.channel === 'LINE') {
      const lines = await tx.$queryRaw<
        { id: string; customerId: string | null; memberId: string | null }[]
      >`
        SELECT id, "customerId", "memberId" FROM "lineMember"
        WHERE "lineUserId" = ${identity.externalUserId} FOR UPDATE`;
      line = lines[0];
      if (!line) throw new NotFoundException('Verified LINE member not found');
    }

    const existing = await tx.channelIdentity.findUnique({
      where: { companyId_channel_connectionKey_externalUserId: namespace },
    });
    const memberCustomer = line?.memberId
      ? await tx.customer.findUnique({
          where: {
            companyId_memberId: {
              companyId: scope.companyId,
              memberId: line.memberId,
            },
          },
        })
      : null;
    const ids = [
      bindCustomerId,
      existing?.customerId,
      line?.customerId,
      memberCustomer?.id,
    ].filter((value): value is string => !!value);
    if (new Set(ids).size > 1)
      throw new ConflictException(
        'Identity already belongs to a different customer; verified merge is required',
      );
    let customer: Customer;
    if (ids.length) {
      customer = await this.requireCustomer(tx, scope, ids[0]);
      if (
        line?.memberId &&
        customer.memberId &&
        customer.memberId !== line.memberId
      )
        throw new ConflictException('Member link conflicts with the customer');
      if (line?.memberId && !customer.memberId) {
        customer = await tx.customer.update({
          where: { id: customer.id, ...partition, memberId: null },
          data: { memberId: line.memberId },
        });
      }
    } else {
      // Serialize a verified legacy Member mapping as well as the channel identity.
      if (line?.memberId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commerce-member:${scope.companyId}:${line.memberId}`}, 0))`;
        const mapped = await tx.customer.findUnique({
          where: {
            companyId_memberId: {
              companyId: scope.companyId,
              memberId: line.memberId,
            },
          },
        });
        customer = mapped
          ? await this.requireCustomer(tx, scope, mapped.id)
          : await tx.customer.create({
              data: { ...partition, memberId: line.memberId },
            });
      } else {
        customer = await tx.customer.create({ data: partition });
      }
    }
    const channelIdentity =
      existing ??
      (await tx.channelIdentity.create({
        data: { ...namespace, customerId: customer.id },
      }));
    if (line) {
      await tx.lineMember.update({
        where: { id: line.id },
        data: { customerId: customer.id },
      });
    }
    return { customer, identity: channelIdentity };
  }

  /** UUID came from Member creation in this same transaction; names/phones never prove a link. */
  async linkRegisteredLine(
    tx: Prisma.TransactionClient,
    scopeInput: CommerceScope,
    identity: VerifiedChannelIdentity,
    memberId: string,
  ) {
    const scope = scoped(scopeInput);
    if (identity.channel !== 'LINE')
      throw new ForbiddenException(
        'LINE registration requires a LINE identity',
      );
    await this.lockIdentity(
      tx,
      scope,
      verifiedChannelIdentitySchema.parse(identity),
    );
    const lines = await tx.$queryRaw<{ id: string; memberId: string | null }[]>`
      SELECT id, "memberId" FROM "lineMember" WHERE "lineUserId" = ${identity.externalUserId} FOR UPDATE`;
    if (!lines[0])
      throw new NotFoundException('Verified LINE member not found');
    if (lines[0].memberId && lines[0].memberId !== memberId)
      throw new ConflictException('LINE account is already linked to a member');
    await tx.lineMember.update({
      where: { id: lines[0].id },
      data: { memberId },
    });
    return this.resolveInTransaction(tx, scope, identity);
  }

  async requireCustomer(
    tx: Prisma.TransactionClient,
    scope: CommerceScope,
    id: string,
  ) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${id}::uuid AND "companyId" = ${scope.companyId}::uuid
      AND "tenantId" IS NULL AND status = 'ACTIVE' FOR UPDATE`;
    if (!rows.length)
      throw new ForbiddenException('Customer identity is unavailable');
    return tx.customer.findFirstOrThrow({
      where: { id, ...commerceDbScope(scope), status: 'ACTIVE' },
    });
  }

  private async lockIdentity(
    tx: Prisma.TransactionClient,
    scope: CommerceScope,
    identity: VerifiedChannelIdentity,
  ) {
    // JSON keeps namespace boundaries distinct even when an external ID contains punctuation.
    const key = JSON.stringify([
      'commerce-identity',
      scope.companyId,
      identity.channel,
      identity.connectionKey,
      identity.externalUserId,
    ]);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}
