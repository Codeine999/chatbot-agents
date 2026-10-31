import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
import { PendingAiUsageError } from '../billing/pending-ai-usage.error';

const DEFAULT_MIN_AI_BALANCE_CREDIT = 20;
const TRANSACTION_RETRY_LIMIT = 10;
const TRANSACTION_RETRY_BASE_DELAY_MS = 10;
const TRANSACTION_RETRY_MAX_DELAY_MS = 200;
const { ReadCommitted, Serializable } = Prisma.TransactionIsolationLevel;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

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
  /** Budget scope the call drew on, stored so the log can be read by scope. */
  scopeKey?: string;
  adminMemberId?: string;
  lineMemberId?: string;
  conversationId?: string;
  providerRequestId?: string;
  latencyMs?: number;
  errorCode?: string;
  /** Overrides the default `usage:<eventId>` ledger key for retried work. */
  idempotencyKey?: string;
  /** Successful provider payload, persisted with settlement for safe replay. */
  result?: Prisma.InputJsonValue;
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
      Number.isFinite(configured)
        ? Math.max(DEFAULT_MIN_AI_BALANCE_CREDIT, configured)
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

    // Reads then writes, so it stays SERIALIZABLE: a concurrent hold makes this
    // edit retry and re-check instead of capping below committed credit.
    return this.runTransaction(Serializable, async (tx) => {
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
   * the scope budget. Both increments run before the checks, which read the
   * rows the UPDATEs return: each row stays locked until commit, so a
   * concurrent caller waits and then sees this hold, and a failed check rolls
   * both increments back. Two callers can never reserve the same credit.
   */
  async reserveAiCredit(
    kind: UsageKind,
    scopeKey: string,
    amountCredit: Prisma.Decimal,
    options: { requireBudgetLimit?: boolean; operationKey?: string } = {},
  ): Promise<CreditHold> {
    const amount = amountCredit.toDecimalPlaces(6, Prisma.Decimal.ROUND_CEIL);
    if (amount.isNegative()) {
      throw new Error('AI credit reservation cannot be negative');
    }

    const companyId = await this.companyService.getCompanyId();
    const wallet = await this.ensureWallet(companyId);
    const budget = await this.ensureBudget(wallet.id, kind, scopeKey);
    let reservationId: string = randomUUID();

    return this.runTransaction(ReadCommitted, async (tx) => {
      const existing = options.operationKey
        ? await tx.creditReservation.findUnique({ where: { operationKey: options.operationKey } })
        : null;
      if (existing && existing.status !== 'RELEASED') throw new PendingAiUsageError();

      // Lock order on every billing path: reservation, wallet, budget.
      if (existing) {
        reservationId = existing.id;
        const reheld = await tx.creditReservation.updateMany({
          where: { id: existing.id, status: 'RELEASED' },
          data: { status: 'HELD', amountCredit: amount, expiresAt: new Date(Date.now() + 120_000) },
        });
        // Another caller re-held the same operation first.
        if (!reheld.count) throw new PendingAiUsageError();
      } else {
        await tx.creditReservation.create({ data: {
          id: reservationId, operationKey: options.operationKey ?? `usage:${reservationId}`,
          companyId, walletId: wallet.id, budgetId: budget.id, amountCredit: amount,
          expiresAt: new Date(Date.now() + 120_000),
        } });
      }

      const currentWallet = await tx.creditWallet.update({
        where: { id: wallet.id },
        data: { reservedCredit: { increment: amount } },
        select: {
          active: true,
          balanceCredit: true,
          reservedCredit: true,
        },
      });
      const currentBudget = await tx.creditBudget.update({
        where: { id: budget.id },
        data: { reservedCredit: { increment: amount } },
        select: {
          limitCredit: true,
          usedCredit: true,
          reservedCredit: true,
        },
      });

      if (!currentWallet.active) {
        throw new InsufficientCreditException('AI credit wallet is inactive');
      }

      if (options.requireBudgetLimit && !currentBudget.limitCredit) {
        throw new InsufficientCreditException(
          `${kind} budget limit is not configured for scope ${scopeKey}`,
        );
      }

      // The returned totals already include this hold; take it back out so
      // the checks and messages describe the credit as it was before.
      const available = currentWallet.balanceCredit
        .minus(currentWallet.reservedCredit)
        .plus(amount);
      const availableAfterReservation = available.minus(amount);
      if (availableAfterReservation.lessThanOrEqualTo(this.minBalanceCredit)) {
        throw new InsufficientCreditException(
          `Insufficient AI credit: reserving ${amount.toString()} from ` +
            `${available.toString()} available would leave ` +
            `${availableAfterReservation.toString()} <= ` +
            `${this.minBalanceCredit.toString()} minimum`,
        );
      }

      const committedBudget = currentBudget.usedCredit
        .plus(currentBudget.reservedCredit)
        .minus(amount);
      if (
        currentBudget.limitCredit &&
        committedBudget.greaterThanOrEqualTo(currentBudget.limitCredit)
      ) {
        throw new InsufficientCreditException(
          `${kind} budget exhausted for scope ${scopeKey}: ` +
            `${committedBudget.toString()}/${currentBudget.limitCredit.toString()} credits`,
        );
      }

      const projectedBudget = committedBudget.plus(amount);
      if (
        currentBudget.limitCredit &&
        projectedBudget.greaterThan(currentBudget.limitCredit)
      ) {
        throw new InsufficientCreditException(
          `${kind} budget exhausted for scope ${scopeKey}: ` +
            `${projectedBudget.toString()}/${currentBudget.limitCredit.toString()} credits including reservations`,
        );
      }

      return {
        id: reservationId,
        companyId,
        walletId: wallet.id,
        budgetId: budget.id,
        amountCredit: amount,
      };
    }).catch((error: unknown) => {
      // A concurrent reserve of the same operation waits on the unique key and
      // fails here once the first commits; report it like an existing hold.
      if (options.operationKey && isUniqueViolation(error)) {
        throw new PendingAiUsageError();
      }
      throw error;
    });
  }

  /**
   * Returns a provider payload only after its debit and usage row committed.
   * A settled legacy reservation without a payload remains unresolved instead
   * of calling the provider again and risking a second external operation.
   */
  async findSettledAiResult(
    operationKey: string,
    kind: UsageKind,
  ): Promise<Prisma.JsonValue | undefined> {
    const reservation = await this.prisma.creditReservation.findUnique({
      where: { operationKey },
      select: { status: true, result: true },
    });
    if (reservation?.status !== 'SETTLED' || !reservation.result) {
      return undefined;
    }

    const stored = reservation.result as Prisma.JsonObject;
    if (stored.kind !== kind || !Object.hasOwn(stored, 'value')) {
      throw new PendingAiUsageError();
    }

    return stored.value;
  }

  /**
   * Writes the usage event and, for a billable success, the wallet debit,
   * budget usage and ledger entry in one transaction. The wallet and budget
   * are moved with atomic SQL decrement/increment rather than a
   * read-modify-write, so concurrent LINE and admin calls cannot clobber each
   * other's balance, and the limits are checked on the totals those UPDATEs
   * return while their row locks are held.
   */
  async recordAiUsage(input: RecordAiUsageInput): Promise<AiUsageSettlement> {
    const { reservation, cost } = input;
    const usageEventId = randomUUID();
    const idempotencyKey = input.idempotencyKey ?? `usage:${reservation.id}`;
    const billable =
      input.status === 'success' && cost.chargedCredit.greaterThan(0);

    try {
      return await this.runTransaction(ReadCommitted, async (tx) => {
        // Claiming the hold first makes a concurrent settlement or release of
        // the same reservation wait here, then find it no longer HELD.
        const claimed = await tx.creditReservation.updateMany({
          where: { id: reservation.id, status: 'HELD' },
          data: {
            status: input.status === 'success' ? 'SETTLED' : 'RELEASED',
            result:
              input.status === 'success' && input.result !== undefined
                ? { kind: input.kind, value: input.result }
                : undefined,
          },
        });
        if (!claimed.count) throw new PendingAiUsageError();
        const chargedCredit = billable
          ? cost.chargedCredit
          : new Prisma.Decimal(0);

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
            scopeKey: input.scopeKey,
            adminMemberId: input.adminMemberId,
            lineMemberId: input.lineMemberId,
            conversationId: input.conversationId,
            providerRequestId: input.providerRequestId?.slice(0, 255),
            latencyMs: input.latencyMs,
            status: input.status,
            errorCode: input.errorCode,
          },
        });

        // The shared rows move last so their locks are held only until commit.
        // Checks read the returned totals: this hold is already released from
        // `reservedCredit` and this charge already applied to the balance.
        const wallet = await tx.creditWallet.update({
          where: { id: reservation.walletId },
          data: {
            reservedCredit: { decrement: reservation.amountCredit },
            balanceCredit: { decrement: chargedCredit },
            lifetimeSpentCredit: { increment: chargedCredit },
          },
          select: { balanceCredit: true, reservedCredit: true },
        });
        if (
          wallet.reservedCredit.isNegative() ||
          wallet.balanceCredit
            .minus(wallet.reservedCredit)
            .lessThanOrEqualTo(this.minBalanceCredit)
        ) {
          throw new InsufficientCreditException(
            `Actual AI charge ${chargedCredit.toString()} exceeds reserved and available credit`,
          );
        }

        const budget = await tx.creditBudget.update({
          where: { id: reservation.budgetId },
          data: {
            reservedCredit: { decrement: reservation.amountCredit },
            usedCredit: { increment: chargedCredit },
          },
          select: {
            limitCredit: true,
            usedCredit: true,
            reservedCredit: true,
          },
        });
        if (
          budget.reservedCredit.isNegative() ||
          (budget.limitCredit &&
            budget.usedCredit
              .plus(budget.reservedCredit)
              .greaterThan(budget.limitCredit))
        ) {
          throw new InsufficientCreditException(
            `Actual AI charge ${chargedCredit.toString()} exceeds the remaining budget`,
          );
        }

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
      if (settled) {
        // The rollback also undid this attempt's hold release, so the credit
        // reserved by *this* call is still sitting on the wallet. Give it back
        // explicitly — the first settlement already moved the real balance.
        await this.releaseAiCredit(reservation);
        return settled;
      }

      throw error;
    }
  }

  /** Releases an aggregate hold after an unexpected billing-path failure. */
  async releaseAiCredit(reservation: CreditHold): Promise<void> {
    // The status guard re-checks after any row-lock wait, so a hold is
    // released exactly once even when two callers race to release it.
    await this.runTransaction(ReadCommitted, async (tx) => {
      const released = await tx.creditReservation.updateMany({
        where: { id: reservation.id, status: { in: ['HELD', 'UNKNOWN'] } },
        data: { status: 'RELEASED' },
      });
      if (!released.count) return;
      await tx.creditWallet.update({
        where: { id: reservation.walletId },
        data: { reservedCredit: { decrement: reservation.amountCredit } },
      });
      await tx.creditBudget.update({
        where: { id: reservation.budgetId },
        data: { reservedCredit: { decrement: reservation.amountCredit } },
      });
    });
  }

  async keepReservationAlive(id: string) {
    await this.prisma.creditReservation.updateMany({
      where: { id, status: 'HELD' }, data: { expiresAt: new Date(Date.now() + 120_000) },
    });
  }

  async markReservationUnknown(id: string): Promise<void> {
    await this.prisma.creditReservation.updateMany({
      where: { id, status: 'HELD' }, data: { status: 'UNKNOWN' },
    });
  }

  async listUnresolvedReservations() {
    const companyId = await this.companyService.getCompanyId();
    // Expiry is a signal for review, never an automatic refund: the provider
    // may have completed while the worker died.
    await this.prisma.creditReservation.updateMany({
      where: { companyId, status: 'HELD', expiresAt: { lt: new Date() } },
      data: { status: 'UNKNOWN' },
    });
    return this.prisma.creditReservation.findMany({
      where: { companyId, status: { in: ['HELD', 'UNKNOWN'] } },
      select: { id: true, operationKey: true, amountCredit: true, status: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'asc' }, take: 100,
    });
  }

  async releaseUnknownReservation(id: string) {
    const companyId = await this.companyService.getCompanyId();
    const hold = await this.prisma.creditReservation.findFirstOrThrow({ where: { id, companyId, status: 'UNKNOWN' } });
    await this.releaseAiCredit(hold);
    return { released: true };
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

  /** Retries P2034: serialization failures and deadlocks. */
  private async runTransaction<T>(
    isolationLevel: Prisma.TransactionIsolationLevel,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, { isolationLevel });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';
        if (!retryable || attempt === TRANSACTION_RETRY_LIMIT) throw error;

        this.logger.warn(
          `Retrying ${isolationLevel} AI credit transaction (${attempt}/${TRANSACTION_RETRY_LIMIT})`,
        );
        // Full jitter: concurrent losers must not retry in lockstep.
        await delay(
          Math.random() *
            Math.min(
              TRANSACTION_RETRY_MAX_DELAY_MS,
              TRANSACTION_RETRY_BASE_DELAY_MS * 2 ** attempt,
            ),
        );
      }
    }

    throw new Error('AI credit transaction retry exhausted');
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
