import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LedgerType,
  Prisma,
  UsageKind,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CompanyService } from '../../admin/company/company.service';
import type {
  AiProviderName,
  AiTokenUsage,
} from '../../../ai-provider/types/ai-provider.types';
import { AiUsageCost } from '../billing/ai-usage.types';
import { InsufficientCreditException } from './insufficient-credit.exception';

const DEFAULT_MIN_AI_BALANCE_CREDIT = 20;
const SERIALIZABLE_RETRY_LIMIT = 3;

/** Aggregate hold created before the provider is contacted. */
export type CreditHold = Readonly<{
  id: string;
  companyId: string;
  walletId: string;
  budgetId: string;
  amountCredit: Prisma.Decimal;
}>;

export type AiUsageSettlement = Readonly<{
  usageEventId: string;
  chargedCredit: Prisma.Decimal;
  balanceAfterCredit: Prisma.Decimal;
}>;

export type RecordAiUsageInput = Readonly<{
  reservation: CreditHold;
  kind: UsageKind;
  provider: AiProviderName;
  model: string;
  usage: AiTokenUsage;
  cost: AiUsageCost;
  status: 'success' | 'failed';
  adminMemberId?: string;
  lineMemberId?: string;
  conversationId?: string;
  providerRequestId?: string;
  latencyMs?: number;
  errorCode?: string;
  /** Overrides the default `usage:<eventId>` ledger key for retried work. */
  idempotencyKey?: string;
}>;

/**
 * The company wallet is the single shared credit balance; `CreditBudget` only
 * caps how much one scope (all LINE replies, or one admin) may draw from it.
 *
 * Billing reserves a conservative maximum before contacting the provider,
 * then settles the actual provider counters and releases the hold atomically.
 */
@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);
  private readonly minBalanceCredit: Prisma.Decimal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly companyService: CompanyService,
    configService: ConfigService,
  ) {
    const configured = Number(
      configService.get('MIN_AI_BALANCE_CREDIT') ??
        DEFAULT_MIN_AI_BALANCE_CREDIT,
    );

    this.minBalanceCredit = new Prisma.Decimal(
      Number.isFinite(configured) && configured >= 0
        ? configured
        : DEFAULT_MIN_AI_BALANCE_CREDIT,
    );
  }

  /** Wallet snapshot for the back office. */
  async getWallet() {
    const companyId = await this.companyService.getCompanyId();
    const wallet = await this.ensureWallet(companyId);

    return {
      id: wallet.id,
      companyId,
      active: wallet.active,
      balanceCredit: wallet.balanceCredit,
      reservedCredit: wallet.reservedCredit,
      availableCredit: wallet.balanceCredit.minus(wallet.reservedCredit),
      lifetimeTopupCredit: wallet.lifetimeTopupCredit,
      lifetimeSpentCredit: wallet.lifetimeSpentCredit,
      minBalanceCredit: this.minBalanceCredit,
    };
  }

  /** Persistent per-scope limits for one usage kind. */
  async listBudgets(kind: UsageKind) {
    const companyId = await this.companyService.getCompanyId();
    const wallet = await this.ensureWallet(companyId);

    return this.prisma.creditBudget.findMany({
      where: { walletId: wallet.id, kind },
      select: {
        id: true,
        scopeKey: true,
        limitCredit: true,
        usedCredit: true,
        reservedCredit: true,
      },
    });
  }

  /**
   * Sets one scope's cap. `null` means unlimited — the wallet balance
   * and the minimum-balance rule still apply either way.
   */
  async setBudgetLimit(
    kind: UsageKind,
    scopeKey: string,
    limitCredit: Prisma.Decimal | null,
  ) {
    const companyId = await this.companyService.getCompanyId();
    const wallet = await this.ensureWallet(companyId);

    const where = {
      walletId_kind_scopeKey: {
        walletId: wallet.id,
        kind,
        scopeKey,
      },
    };

    return this.runSerializable(async (tx) => {
      const current = await tx.creditBudget.findUnique({
        where,
        select: { usedCredit: true, reservedCredit: true },
      });
      const committed = current
        ? current.usedCredit.plus(current.reservedCredit)
        : new Prisma.Decimal(0);
      if (limitCredit && limitCredit.lessThan(committed)) {
        throw new InsufficientCreditException(
          `Budget limit ${limitCredit.toString()} is below ` +
            `${committed.toString()} used or reserved credits`,
        );
      }

      return tx.creditBudget.upsert({
        where,
        create: { walletId: wallet.id, kind, scopeKey, limitCredit },
        update: { limitCredit },
        select: {
          id: true,
          scopeKey: true,
          limitCredit: true,
          usedCredit: true,
          reservedCredit: true,
        },
      });
    });
  }

  /**
   * Atomically holds the maximum expected charge in both the shared wallet and
   * the scope budget. Serializable isolation prevents two concurrent callers
   * from both reserving the same available credit.
   */
  async reserveAiCredit(
    kind: UsageKind,
    scopeKey: string,
    amountCredit: Prisma.Decimal,
  ): Promise<CreditHold> {
    const amount = amountCredit.toDecimalPlaces(6, Prisma.Decimal.ROUND_CEIL);
    if (amount.isNegative()) {
      throw new Error('AI credit reservation cannot be negative');
    }

    const companyId = await this.companyService.getCompanyId();
    const wallet = await this.ensureWallet(companyId);
    const budget = await this.ensureBudget(wallet.id, kind, scopeKey);
    const reservationId = randomUUID();

    return this.runSerializable(async (tx) => {
      const [currentWallet, currentBudget] = await Promise.all([
        tx.creditWallet.findUniqueOrThrow({
          where: { id: wallet.id },
          select: {
            active: true,
            balanceCredit: true,
            reservedCredit: true,
          },
        }),
        tx.creditBudget.findUniqueOrThrow({
          where: { id: budget.id },
          select: {
            limitCredit: true,
            usedCredit: true,
            reservedCredit: true,
          },
        }),
      ]);

      if (!currentWallet.active) {
        throw new InsufficientCreditException('AI credit wallet is inactive');
      }

      const available = currentWallet.balanceCredit.minus(
        currentWallet.reservedCredit,
      );
      const availableAfterReservation = available.minus(amount);
      if (availableAfterReservation.lessThan(this.minBalanceCredit)) {
        throw new InsufficientCreditException(
          `Insufficient AI credit: reserving ${amount.toString()} from ` +
            `${available.toString()} available would leave ` +
            `${availableAfterReservation.toString()} < ` +
            `${this.minBalanceCredit.toString()} minimum`,
        );
      }

      const projectedBudget = currentBudget.usedCredit
        .plus(currentBudget.reservedCredit)
        .plus(amount);
      if (
        currentBudget.limitCredit &&
        projectedBudget.greaterThan(currentBudget.limitCredit)
      ) {
        throw new InsufficientCreditException(
          `${kind} budget exhausted for scope ${scopeKey}: ` +
            `${projectedBudget.toString()}/${currentBudget.limitCredit.toString()} credits including reservations`,
        );
      }

      await Promise.all([
        tx.creditWallet.update({
          where: { id: wallet.id },
          data: { reservedCredit: { increment: amount } },
        }),
        tx.creditBudget.update({
          where: { id: budget.id },
          data: { reservedCredit: { increment: amount } },
        }),
      ]);

      return {
        id: reservationId,
        companyId,
        walletId: wallet.id,
        budgetId: budget.id,
        amountCredit: amount,
      };
    });
  }

  /**
   * Writes the usage event and, for a billable success, the wallet debit,
   * budget usage and ledger entry in one transaction. The wallet and budget
   * are moved with atomic SQL decrement/increment rather than a
   * read-modify-write, so concurrent LINE and admin calls cannot clobber each
   * other's balance.
   */
  async recordAiUsage(input: RecordAiUsageInput): Promise<AiUsageSettlement> {
    const { reservation, cost } = input;
    const usageEventId = randomUUID();
    const idempotencyKey = input.idempotencyKey ?? `usage:${reservation.id}`;
    const billable =
      input.status === 'success' && cost.chargedCredit.greaterThan(0);

    try {
      return await this.runSerializable(async (tx) => {
        const chargedCredit = billable
          ? cost.chargedCredit
          : new Prisma.Decimal(0);
        const [walletBefore, budgetBefore] = await Promise.all([
          tx.creditWallet.findUniqueOrThrow({
            where: { id: reservation.walletId },
            select: { balanceCredit: true, reservedCredit: true },
          }),
          tx.creditBudget.findUniqueOrThrow({
            where: { id: reservation.budgetId },
            select: {
              limitCredit: true,
              usedCredit: true,
              reservedCredit: true,
            },
          }),
        ]);

        const otherWalletReservations = walletBefore.reservedCredit.minus(
          reservation.amountCredit,
        );
        if (
          otherWalletReservations.isNegative() ||
          walletBefore.balanceCredit
            .minus(otherWalletReservations)
            .minus(chargedCredit)
            .lessThan(this.minBalanceCredit)
        ) {
          throw new InsufficientCreditException(
            `Actual AI charge ${chargedCredit.toString()} exceeds reserved and available credit`,
          );
        }

        const otherBudgetReservations = budgetBefore.reservedCredit.minus(
          reservation.amountCredit,
        );
        const projectedBudget = budgetBefore.usedCredit
          .plus(otherBudgetReservations)
          .plus(chargedCredit);
        if (
          otherBudgetReservations.isNegative() ||
          (budgetBefore.limitCredit &&
            projectedBudget.greaterThan(budgetBefore.limitCredit))
        ) {
          throw new InsufficientCreditException(
            `Actual AI charge ${chargedCredit.toString()} exceeds the remaining budget`,
          );
        }

        await tx.aiUsageEvent.create({
          data: {
            id: usageEventId,
            companyId: reservation.companyId,
            kind: input.kind,
            provider: input.provider,
            model: input.model,
            inputTokens: input.usage.inputTokens,
            cachedInputTokens: input.usage.cachedInputTokens,
            cacheWriteTokens: input.usage.cacheWriteTokens,
            outputTokens: input.usage.outputTokens,
            costThb: cost.costThb,
            chargedCredit,
            pricingId: cost.pricingId,
            adminMemberId: input.adminMemberId,
            lineMemberId: input.lineMemberId,
            conversationId: input.conversationId,
            providerRequestId: input.providerRequestId?.slice(0, 255),
            latencyMs: input.latencyMs,
            status: input.status,
            errorCode: input.errorCode,
          },
        });

        const wallet = await tx.creditWallet.update({
          where: { id: reservation.walletId },
          data: {
            reservedCredit: { decrement: reservation.amountCredit },
            balanceCredit: { decrement: chargedCredit },
            lifetimeSpentCredit: { increment: chargedCredit },
          },
          select: { balanceCredit: true },
        });

        await tx.creditBudget.update({
          where: { id: reservation.budgetId },
          data: {
            reservedCredit: { decrement: reservation.amountCredit },
            usedCredit: { increment: chargedCredit },
          },
        });

        if (billable) {
          await tx.creditLedger.create({
            data: {
              walletId: reservation.walletId,
              type: LedgerType.DEBIT,
              kind: input.kind,
              amountCredit: chargedCredit.negated(),
              balanceAfterCredit: wallet.balanceCredit,
              usageEventId,
              idempotencyKey,
            },
          });
        }

        return {
          usageEventId,
          chargedCredit,
          balanceAfterCredit: wallet.balanceCredit,
        };
      });
    } catch (error) {
      // `idempotencyKey` and `usageEventId` are both unique: a retry that
      // reaches here has already been charged, and the whole transaction was
      // rolled back rather than debited twice.
      const settled = await this.findSettledUsage(idempotencyKey, error);
      if (settled) return settled;

      throw error;
    }
  }

  /** Releases an aggregate hold after an unexpected billing-path failure. */
  async releaseAiCredit(reservation: CreditHold): Promise<void> {
    await this.runSerializable(async (tx) => {
      await Promise.all([
        tx.creditWallet.update({
          where: { id: reservation.walletId },
          data: { reservedCredit: { decrement: reservation.amountCredit } },
        }),
        tx.creditBudget.update({
          where: { id: reservation.budgetId },
          data: { reservedCredit: { decrement: reservation.amountCredit } },
        }),
      ]);
    });
  }

  /** Wallet rows are created lazily so a fresh install is visible at 0 credit. */
  private async ensureWallet(companyId: string) {
    const select = {
      id: true,
      active: true,
      balanceCredit: true,
      reservedCredit: true,
      lifetimeTopupCredit: true,
      lifetimeSpentCredit: true,
    } as const;

    // Read first: the row exists for every call after the first, so the hot
    // path stays a single indexed select instead of a write.
    const existing = await this.prisma.creditWallet.findUnique({
      where: { companyId },
      select,
    });

    if (existing) return existing;

    return this.prisma.creditWallet.upsert({
      where: { companyId },
      create: { companyId },
      update: {},
      select,
    });
  }

  /**
   * Budgets default to `limitCredit: null` (unlimited) — a scope is capped
   * only once someone sets a limit, so adding an admin never locks them out.
   */
  private async ensureBudget(
    walletId: string,
    kind: UsageKind,
    scopeKey: string,
  ) {
    const where = {
      walletId_kind_scopeKey: { walletId, kind, scopeKey },
    };
    const select = {
      id: true,
      limitCredit: true,
      usedCredit: true,
      reservedCredit: true,
    } as const;

    const existing = await this.prisma.creditBudget.findUnique({
      where,
      select,
    });

    if (existing) return existing;

    return this.prisma.creditBudget.upsert({
      where,
      create: { walletId, kind, scopeKey },
      update: {},
      select,
    });
  }

  private async runSerializable<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';
        if (!retryable || attempt === SERIALIZABLE_RETRY_LIMIT) throw error;

        this.logger.warn(
          `Retrying serialized AI credit transaction (${attempt}/${SERIALIZABLE_RETRY_LIMIT})`,
        );
      }
    }

    throw new Error('Serializable AI credit transaction retry exhausted');
  }

  private async findSettledUsage(
    idempotencyKey: string,
    error: unknown,
  ): Promise<AiUsageSettlement | null> {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return null;
    }

    const existing = await this.prisma.creditLedger.findUnique({
      where: { idempotencyKey },
      select: {
        usageEventId: true,
        amountCredit: true,
        balanceAfterCredit: true,
      },
    });

    if (!existing?.usageEventId) return null;

    this.logger.warn(
      `Duplicate AI usage settlement ignored for ${idempotencyKey}`,
    );

    return {
      usageEventId: existing.usageEventId,
      chargedCredit: existing.amountCredit.negated(),
      balanceAfterCredit: existing.balanceAfterCredit,
    };
  }
}
