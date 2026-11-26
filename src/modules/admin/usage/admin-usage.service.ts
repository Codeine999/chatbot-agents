import { Injectable } from '@nestjs/common';
import {
  MessageChannel,
  Prisma,
  UsageKind,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  AdminRole,
  AuthenticatedAdmin,
} from '../../../shared/guards/admin-auth.types';
import { LineAdminService } from '../../channels/line/admin/line-admin.service';
import type { LineMessageQuota } from '../../channels/line/admin/line-admin.service';
import { CompanyService } from '../company/company.service';
import type { UsageRepliesQueryDto } from './dto/usage-replies-query.dto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AdminCreditBudget = {
  adminMemberId: string;
  username: string;
  firstname: string;
  lastname: string;
  role: AdminRole;
  walletId: string;
  limitCredit: Prisma.Decimal | null;
  usedCredit: Prisma.Decimal | number;
  reservedCredit: Prisma.Decimal | number;
};

type ReplyUsageRow = {
  reply: string;
  channel: MessageChannel | null;
  created_at: Date;
  credit: Prisma.Decimal;
  answer_type: string | null;
  failed: number;
  admin_query: boolean;
  admin_id: string | null;
  total: number;
};

export type UsageReply = {
  /** The turn id of the reply (or the usage event id when no turn is known). */
  id: string;
  createdAt: Date;
  /** Null when the turn left no decision log (older than its retention, or a tool run). */
  channel: MessageChannel | null;
  respondedBy: 'AI' | 'ADMIN';
  adminUsername: string | null;
  /** Credits charged by this system for the whole reply, never provider tokens. */
  chargedCredit: string;
  /** What the reply was (KNOWLEDGE, PRODUCT, GENERAL, ...); null without a decision log. */
  answerType: string | null;
  status: 'success' | 'failed';
};

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_SQL =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

@Injectable()
export class AdminUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyService: CompanyService,
    private readonly lineAdminService: LineAdminService,
  ) {}

  /**
   * Push-message allowance from the LINE plan itself (not credits).
   * `type: 'none'` means the plan has no cap, so `value` is absent.
   */
  getLinePushMessageQuota(): Promise<LineMessageQuota> {
    return this.lineAdminService.getMessageQuota();
  }

  /**
   * The company has one shared wallet. Each admin's own allocation is the
   * ADMIN_AI_QUERY budget whose scope key is that admin's member id.
   */
  async getUsage(adminMemberId: string) {
    const companyId = await this.companyService.getCompanyId();
    const wallet = await this.prisma.creditWallet.findUnique({
      where: { companyId },
      select: { id: true, balanceCredit: true, lifetimeSpentCredit: true },
    });
    const adminBudget = wallet
      ? await this.prisma.creditBudget.findUnique({
          where: {
            walletId_kind_scopeKey: {
              walletId: wallet.id,
              kind: UsageKind.ADMIN_AI_QUERY,
              scopeKey: adminMemberId,
            },
          },
          select: {
            walletId: true,
            limitCredit: true,
            usedCredit: true,
          },
        })
      : null;

    return {
      companyCredit: {
        balanceCredit: wallet?.balanceCredit ?? 0,
        usedCredit: wallet?.lifetimeSpentCredit ?? 0,
      },
      adminCredit: {
        admin: {
          walletId: adminBudget?.walletId ?? wallet?.id ?? '',
          limitCredit: adminBudget?.limitCredit ?? null,
          usedCredit: adminBudget?.usedCredit ?? 0,
        },
      },
    };
  }

  /**
   * Budget list keyed by admin account. `dev` and `owner` see every admin that
   * owns an ADMIN_AI_QUERY budget; a plain `admin` only ever sees their own.
   */
  async getUsageAllAdmin(actor: AuthenticatedAdmin) {
    const seesEveryAdmin = actor.role === 'dev' || actor.role === 'owner';
    const budgets = await this.prisma.creditBudget.findMany({
      where: {
        kind: UsageKind.ADMIN_AI_QUERY,
        ...(seesEveryAdmin ? {} : { scopeKey: actor.id }),
      },
      select: {
        walletId: true,
        scopeKey: true,
        limitCredit: true,
        usedCredit: true,
        reservedCredit: true,
      },
    });

    // scopeKey is free-form text — only rows scoped to an admin id can be joined.
    const adminIds = budgets
      .map((budget) => budget.scopeKey)
      .filter((scopeKey) => UUID_PATTERN.test(scopeKey));

    const admins = adminIds.length
      ? await this.prisma.adminMember.findMany({
          where: { id: { in: adminIds } },
          select: {
            id: true,
            username: true,
            firstname: true,
            lastname: true,
            role: true,
          },
          orderBy: { username: 'asc' },
        })
      : [];

    const budgetByAdminId = new Map(
      budgets.map((budget) => [budget.scopeKey, budget]),
    );

    const rows: AdminCreditBudget[] = admins.flatMap((admin) => {
      const budget = budgetByAdminId.get(admin.id);
      if (!budget) return [];

      return [
        {
          adminMemberId: admin.id,
          username: admin.username,
          firstname: admin.firstname,
          lastname: admin.lastname,
          role: admin.role,
          walletId: budget.walletId,
          limitCredit: budget.limitCredit ?? null,
          usedCredit: budget.usedCredit ?? 0,
          reservedCredit: budget.reservedCredit ?? 0,
        },
      ];
    });

    // The caller's own account always leads the list; the rest stay username-sorted.
    rows.sort((a, b) => {
      if (a.adminMemberId === actor.id) return -1;
      if (b.adminMemberId === actor.id) return 1;
      return 0;
    });

    return { admins: rows };
  }
  /**
   * One row per customer reply with the credits this system charged for it.
   *
   * A reply is several billed calls (planner, answer, embedding). They share
   * the turn id inside the ledger idempotency key (`usage:<turn>:<hash>`,
   * `usage:embed:<turn>:<hash>`, `usage:product:<commerceTurnId>:<slot>`), and
   * the decision log of that turn says which channel it came from. Without one
   * the channel is read from the turn id prefix (`app:`, `fb:`), the room the
   * call was billed to, or the LINE member. Calls with
   * no turn id (an admin asking the AI) get a row of their own.
   * Indexing embeddings (scope `document`) are not replies and are left out.
   * A plain `admin` only sees their own admin-AI rows.
   */
  async getReplyLog(actor: AuthenticatedAdmin, query: UsageRepliesQueryDto) {
    const companyId = await this.companyService.getCompanyId();
    const now = Date.now();
    const since = new Date(now - query.days * DAY_MS);
    const decisionSince = new Date(since.getTime() - DAY_MS);
    const seesEveryAdmin = actor.role === 'dev' || actor.role === 'owner';
    const offset = (query.page - 1) * query.limit;

    const ownAdminOnly = seesEveryAdmin
      ? Prisma.empty
      : Prisma.sql`AND (e.kind <> 'ADMIN_AI_QUERY' OR e."adminMemberId" = ${actor.id}::uuid)`;
    const channelFilter = query.channel
      ? Prisma.sql`WHERE channel = ${query.channel}::"MessageChannel"`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<ReplyUsageRow[]>`
      WITH ev AS (
        SELECT e.id, e."createdAt", e.kind, e."chargedCredit", e.status, e."adminMemberId",
          e."conversationId", e."lineMemberId",
          CASE WHEN l."idempotencyKey" IS NULL THEN e.id::text
            ELSE regexp_replace(
              regexp_replace(l."idempotencyKey", '^usage:(embed:|product:)?', ''),
              ':[^:]*$', '') END AS turn
        FROM "aiUsageEvents" e
        LEFT JOIN "creditLedger" l ON l."usageEventId" = e.id
        WHERE e."companyId" = ${companyId}::uuid
          AND e."createdAt" >= ${since}
          AND (e.kind IN ('LINE_AI_REPLY', 'ADMIN_AI_QUERY')
            OR (e.kind = 'EMBEDDING' AND e."scopeKey" = 'query'))
          ${ownAdminOnly}
      ), resolved AS (
        SELECT ev.*,
          COALESCE(d."eventId", dc."eventId", ev.turn) AS reply,
          COALESCE(
            d.channel,
            dc.channel,
            CASE
              WHEN ev.turn LIKE 'app:%' THEN 'APPLICATION'
              WHEN ev.turn LIKE 'fb:%' THEN 'FACEBOOK'
              WHEN cc.channel = 'APP' THEN 'APPLICATION'
              WHEN cc.channel = 'FACEBOOK' THEN 'FACEBOOK'
              WHEN lc.id IS NOT NULL OR ev."lineMemberId" IS NOT NULL THEN 'LINE'
            END::"MessageChannel"
          ) AS channel,
          COALESCE(d."answerType", dc."answerType") AS answer_type
        FROM ev
        LEFT JOIN "decisionLogs" d
          ON d."companyId" = ${companyId}::uuid AND d."eventId" = ev.turn
        LEFT JOIN "channelConversations" cc ON cc.id = ev."conversationId"
        LEFT JOIN "lineConversation" lc ON lc.id = ev."conversationId"
        LEFT JOIN "decisionLogs" dc
          ON dc."companyId" = ${companyId}::uuid
          AND dc."createdAt" >= ${decisionSince}
          AND dc."commerceTurnId" =
            CASE WHEN ev.turn ~* ${UUID_SQL} THEN ev.turn::uuid END
      ), grouped AS (
        SELECT reply,
          (array_agg(channel) FILTER (WHERE channel IS NOT NULL))[1] AS channel,
          max("createdAt") AS created_at,
          sum("chargedCredit") AS credit,
          (array_agg(answer_type) FILTER (WHERE answer_type IS NOT NULL))[1] AS answer_type,
          (count(*) FILTER (WHERE status <> 'success'))::int AS failed,
          bool_or(kind = 'ADMIN_AI_QUERY') AS admin_query,
          (array_agg("adminMemberId") FILTER (WHERE "adminMemberId" IS NOT NULL))[1]::text AS admin_id
        FROM resolved
        GROUP BY reply
      )
      SELECT *, (count(*) OVER ())::int AS total
      FROM grouped
      ${channelFilter}
      ORDER BY created_at DESC, reply
      LIMIT ${query.limit} OFFSET ${offset}
    `;

    const adminIds = [
      ...new Set(rows.flatMap((row) => (row.admin_id ? [row.admin_id] : []))),
    ];
    const admins = adminIds.length
      ? await this.prisma.adminMember.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, username: true },
        })
      : [];
    const usernameById = new Map(admins.map((a) => [a.id, a.username]));

    const items: UsageReply[] = rows.map((row) => ({
      id: row.reply,
      createdAt: row.created_at,
      channel: row.channel,
      respondedBy: row.admin_query ? 'ADMIN' : 'AI',
      adminUsername: row.admin_id
        ? (usernameById.get(row.admin_id) ?? null)
        : null,
      chargedCredit: new Prisma.Decimal(row.credit).toFixed(6),
      answerType: row.answer_type,
      status: row.failed > 0 ? 'failed' : 'success',
    }));

    return {
      items,
      page: query.page,
      limit: query.limit,
      total: rows[0]?.total ?? 0,
    };
  }
}
