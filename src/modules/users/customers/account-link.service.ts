import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  scoped,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import { CustomerIdentityService } from './customer-identity.service';
import {
  verifiedChannelIdentitySchema,
  type VerifiedChannelIdentity,
} from './types/channel-identity';

const LINK_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class AccountLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identities: CustomerIdentityService,
  ) {}

  /** Internal authenticated commands. No public endpoint accepts arbitrary buyer IDs. */
  async issue(scopeInput: CommerceScope, source: VerifiedChannelIdentity) {
    const scope = scoped(scopeInput);
    const { customer } = await this.identities.resolveOrCreate(scope, source);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_TTL_MS);
    await this.prisma.accountLinkChallenge.create({
      data: {
        companyId: scope.companyId,
        customerId: customer.id,
        tokenHash: hashToken(token),
        expiresAt,
      },
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async redeem(
    scopeInput: CommerceScope,
    token: string,
    targetInput: VerifiedChannelIdentity,
  ) {
    const scope = scoped(scopeInput);
    const target = verifiedChannelIdentitySchema.parse(targetInput);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ConflictException('Invalid or expired account link');
    return this.prisma.$transaction(async (tx) => {
      const challenges = await tx.$queryRaw<
        {
          id: string;
          customerId: string;
          expiresAt: Date;
          consumedAt: Date | null;
        }[]
      >`
        SELECT id, "customerId", "expiresAt", "consumedAt" FROM "accountLinkChallenges"
        WHERE "tokenHash" = ${hashToken(token)} AND "companyId" = ${scope.companyId}::uuid FOR UPDATE`;
      const challenge = challenges[0];
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= Date.now()
      )
        throw new ConflictException('Invalid or expired account link');
      const result = await this.identities.resolveInTransaction(
        tx,
        scope,
        target,
        challenge.customerId,
      );
      await tx.accountLinkChallenge.update({
        where: { id: challenge.id, companyId: scope.companyId },
        data: {
          consumedAt: new Date(),
          redeemedIdentityId: result.identity.id,
        },
      });
      return result;
    });
  }
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
