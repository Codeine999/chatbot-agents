import { Prisma } from '../../../generated/prisma/client';
import type { BusinessCapabilities } from '../attributes/types/attribute-definition.types';
import {
  localDateString,
  pad2,
  zonedParts,
  zonedToUtc,
} from '../time/product-clock';
import type {
  ProductEvidence,
  ProductPlan,
  ProductSearchResult,
  SlotEvidence,
} from '../search/product-search.types';
import { sqlTimestamp } from './slot-time';
import {
  effectivePrice,
  fitsBudget,
  type PriceEnvelope,
} from '../product-pricing';
import {
  DEFAULT_SLOT_CONFIG,
  isOffer,
  slotAvailability,
} from './slot-availability';

const ROW_CAP = 500;
const EVIDENCE_CAP = 12;
const ALTERNATIVES = 3;

type SlotRow = {
  id: string;
  variantId: string;
  startsAt: Date;
  endsAt: Date | null;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  capacity: number | null;
  reserved: number;
  availabilityAt: Date | null;
  /** This round's own fare; null = the variant's pair applies. */
  price: Prisma.Decimal | null;
  maxPrice: Prisma.Decimal | null;
  variantPrice: Prisma.Decimal | null;
  variantMaxPrice: Prisma.Decimal | null;
};
type Judged = SlotRow & Pick<SlotEvidence, 'state' | 'seatsLeft'>;

/** Does this question need dated slots at all? Price-only questions never do. */
export function wantsSlots(
  plan: ProductPlan,
  capabilities: BusinessCapabilities,
): boolean {
  return (
    capabilities.inventory === 'SLOT_CAPACITY' &&
    (Boolean(plan.when) ||
      Boolean(plan.slotIds?.length) ||
      plan.operation === 'NEXT' ||
      plan.asks.includes('SCHEDULE') ||
      plan.asks.includes('STOCK'))
  );
}

export type SlotSearchInput = {
  db: Prisma.TransactionClient;
  companyId: string;
  plan: ProductPlan;
  capabilities: BusinessCapabilities;
  result: ProductSearchResult;
  now: Date;
  timeZone: string;
  /** Variant facts (relaxed to the product, not the customer's option filters). */
  variantEvidence: (variantIds: string[]) => Promise<ProductEvidence[]>;
  /** Other variants of the same products, for alternatives. */
  siblingVariantIds: (productIds: string[]) => Promise<string[]>;
};

const SLOT_COLUMNS = Prisma.sql`s.id, s."variantId", s."startsAt", s."endsAt", s.status,
  s.capacity, s.reserved, s."availabilityAt", s.price, s."maxPrice",
  v.price AS "variantPrice", v."maxPrice" AS "variantMaxPrice"`;
const VARIANT_PRICE_JOIN = Prisma.sql`JOIN "productVariants" v
  ON v.id = s."variantId" AND v."companyId" = s."companyId"`;

/** The fare of one round: its own pair, else its variant's (never mixed). */
const roundPrice = (row: SlotRow) =>
  effectivePrice(
    { price: row.variantPrice, maxPrice: row.variantMaxPrice },
    row,
  );

/** Midnight after the last answerable local day. */
function horizonEndOf(
  now: Date,
  timeZone: string,
  config: { horizonDays: number },
): Date {
  const today = localDateString(zonedParts(now, timeZone));
  return zonedToUtc(
    { ...addLocalDays(today, config.horizonDays + 1), hour: 0, minute: 0 },
    timeZone,
  );
}

/**
 * Lowest/highest fare over each variant's rounds that can still be taken in
 * the answerable window, for a question that names no round ("กี่บาท").
 * Variants whose rounds all use the variant's own price are left out: their
 * price is the variant's, not a spread over rounds. One read-only aggregate in
 * the caller's transaction.
 */
export async function slotPriceEnvelopes(input: {
  db: Prisma.TransactionClient;
  companyId: string;
  variantIds: readonly string[];
  capabilities: BusinessCapabilities;
  now: Date;
  timeZone: string;
}): Promise<Map<string, PriceEnvelope>> {
  const { db, companyId, capabilities, now, timeZone } = input;
  const variantIds = [...new Set(input.variantIds)];
  if (!variantIds.length) return new Map();
  const config = capabilities.slot ?? DEFAULT_SLOT_CONFIG;
  const earliest = new Date(now.getTime() + config.cutoffMinutes * 60_000);
  const rows = await db.$queryRaw<
    {
      variantId: string;
      low: Prisma.Decimal | null;
      high: Prisma.Decimal | null;
      hasEstimate: boolean;
    }[]
  >(Prisma.sql`
    SELECT s."variantId",
      MIN(CASE WHEN s.price IS NOT NULL THEN s.price ELSE v.price END) AS low,
      MAX(CASE WHEN s.price IS NOT NULL THEN COALESCE(s."maxPrice", s.price)
               ELSE COALESCE(v."maxPrice", v.price) END) AS high,
      BOOL_OR(CASE WHEN s.price IS NOT NULL THEN s."maxPrice" IS NOT NULL
                   ELSE v."maxPrice" IS NOT NULL END) AS "hasEstimate"
    FROM "productSlots" s ${VARIANT_PRICE_JOIN}
    WHERE s."companyId" = ${companyId}::uuid
      AND s."variantId" = ANY(${variantIds}::uuid[])
      AND s.status = 'OPEN'
      AND s."startsAt" >= ${sqlTimestamp(earliest)}::timestamp
      AND s."startsAt" < ${sqlTimestamp(horizonEndOf(now, timeZone, config))}::timestamp
    GROUP BY s."variantId"
    HAVING BOOL_OR(s.price IS NOT NULL)`);
  return new Map(
    rows.map((r) => [
      r.variantId,
      { low: r.low, high: r.high, hasEstimate: r.hasEstimate },
    ]),
  );
}

const localTime = (instant: Date, timeZone: string) => {
  const parts = zonedParts(instant, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
};

function addLocalDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

async function findSlots(
  db: Prisma.TransactionClient,
  companyId: string,
  variantIds: string[],
  from: Date,
  to: Date,
  timeZone: string,
  after: string | null,
  before: string | null,
): Promise<SlotRow[]> {
  if (!variantIds.length) return [];
  return db.$queryRaw<SlotRow[]>(Prisma.sql`
    SELECT ${SLOT_COLUMNS}
    FROM "productSlots" s ${VARIANT_PRICE_JOIN}
    WHERE s."companyId" = ${companyId}::uuid
      AND s."variantId" = ANY(${variantIds}::uuid[])
      AND s."startsAt" >= ${sqlTimestamp(from)}::timestamp
      AND s."startsAt" < ${sqlTimestamp(to)}::timestamp
      AND s.status <> 'CANCELLED'
      ${after ? Prisma.sql`AND (s."startsAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::time >= ${after}::time` : Prisma.empty}
      ${before ? Prisma.sql`AND (s."startsAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::time < ${before}::time` : Prisma.empty}
    ORDER BY s."startsAt", s."variantId"
    LIMIT ${ROW_CAP}`);
}

/**
 * Looks up dated slots for the variants a search found (deterministic, in the
 * same transaction), judges each one, and adds near alternatives when the
 * requested time does not fit.
 */
export async function searchSlots(
  input: SlotSearchInput,
): Promise<ProductSearchResult> {
  const { db, companyId, plan, capabilities, result, now, timeZone } = input;
  const config = capabilities.slot ?? DEFAULT_SLOT_CONFIG;
  const quantity = plan.quantity ?? null;
  const query = {
    date: plan.when?.date ?? null,
    after: plan.when?.after ?? null,
    before: plan.when?.before ?? null,
    quantity,
  };
  const today = localDateString(zonedParts(now, timeZone));
  const horizonEnd = horizonEndOf(now, timeZone, config);
  const earliest = new Date(now.getTime() + config.cutoffMinutes * 60_000);

  // Which route/variants? One route answers; several named only by a place ask which.
  const variantEvidence = result.evidence;
  const products = [...new Set(variantEvidence.map((e) => e.productId))];
  if (!plan.slotIds?.length && !result.identified && products.length > 1) {
    const names = new Map<string, string>();
    for (const e of variantEvidence)
      if (names.size < 5 && !names.has(e.productId))
        names.set(e.productId, e.name);
    return {
      ...result,
      status: 'MISSING_INPUT',
      evidence: [],
      choices: [...names].map(([id, name]) => ({ id, name })),
      query,
    };
  }

  // Window of the customer's question.
  let from = now;
  let to = horizonEnd;
  if (query.date) {
    const dayStart = zonedToUtc(
      { ...addLocalDays(query.date, 0), hour: 0, minute: 0 },
      timeZone,
    );
    const dayEnd = zonedToUtc(
      { ...addLocalDays(query.date, 1), hour: 0, minute: 0 },
      timeZone,
    );
    if (query.date < today || dayStart.getTime() >= horizonEnd.getTime())
      return { ...result, slotOutcome: 'OUT_OF_WINDOW', query, timeZone };
    from = new Date(Math.max(dayStart.getTime(), now.getTime()));
    to = dayEnd;
  } else if (plan.operation === 'NEXT') {
    to = new Date(
      Math.min(
        now.getTime() + (config.nextWithinHours ?? 24) * 3_600_000,
        horizonEnd.getTime(),
      ),
    );
  }

  const judge = (row: SlotRow): Judged => ({
    ...row,
    ...slotAvailability(row, now, capabilities, quantity),
  });
  // "ไม่เกิน 400" applies to each round's own fare, the route's being only a summary.
  const inBudget = (row: SlotRow) =>
    fitsBudget(roundPrice(row), plan.minPrice, plan.maxPrice);

  let variantIds = [...new Set(variantEvidence.map((e) => e.variantId))];
  let rows: Judged[];
  if (plan.slotIds?.length && plan.operation === 'NEXT') {
    // "แล้วรอบถัดไปล่ะ" after a round that was just discussed: the round that
    // follows the latest one referenced, whatever state the referenced one is in.
    const anchors = await db.$queryRaw<{ variantId: string; startsAt: Date }[]>(
      Prisma.sql`
      SELECT s."variantId", s."startsAt"
      FROM "productSlots" s
      WHERE s."companyId" = ${companyId}::uuid AND s.id = ANY(${plan.slotIds}::uuid[])`,
    );
    variantIds = [...new Set(anchors.map((r) => r.variantId))];
    const last = Math.max(...anchors.map((r) => r.startsAt.getTime()), 0);
    rows = anchors.length
      ? (
          await findSlots(
            db,
            companyId,
            variantIds,
            new Date(Math.max(last + 1, now.getTime())),
            horizonEnd,
            timeZone,
            null,
            null,
          )
        )
          .filter(inBudget)
          .map(judge)
      : [];
  } else if (plan.slotIds?.length) {
    const named = await db.$queryRaw<SlotRow[]>(Prisma.sql`
      SELECT ${SLOT_COLUMNS}
      FROM "productSlots" s ${VARIANT_PRICE_JOIN}
      WHERE s."companyId" = ${companyId}::uuid
        AND s.id = ANY(${plan.slotIds}::uuid[]) AND s.status <> 'CANCELLED'
        AND s."startsAt" >= ${sqlTimestamp(now)}::timestamp
      ORDER BY s."startsAt", s."variantId"`);
    rows = named.filter(inBudget).map(judge);
    variantIds = [...new Set(named.map((r) => r.variantId))];
  } else {
    rows = (
      await findSlots(
        db,
        companyId,
        variantIds,
        from,
        to,
        timeZone,
        query.after,
        query.before,
      )
    )
      .filter(inBudget)
      .map(judge);
  }

  const needsFit = plan.asks.includes('STOCK') || quantity !== null;
  let requested: Judged[];
  if (plan.operation === 'NEXT') {
    // The first slot that can still be taken, never one inside the cutoff.
    const first = rows.find(
      (r) => r.startsAt.getTime() >= earliest.getTime() && isOffer(r.state),
    );
    requested = first ? [first] : [];
  } else {
    requested = rows;
  }
  const fits = requested.filter((r) => isOffer(r.state));
  const outcome: ProductSearchResult['slotOutcome'] = !requested.length
    ? 'NO_SLOT_IN_WINDOW'
    : needsFit && !fits.length
      ? 'NONE_FITS'
      : 'MATCHED';

  // Near alternatives when what was asked for cannot be taken.
  let alternatives: Judged[] = [];
  if (outcome !== 'MATCHED') {
    const siblings = plan.slotIds?.length
      ? variantIds
      : [
          ...new Set([
            ...variantIds,
            ...(await input.siblingVariantIds(products)),
          ]),
        ];
    const anchor = anchorOf(query, from, timeZone);
    const near = (
      await findSlots(
        db,
        companyId,
        siblings,
        new Date(
          Math.max(anchor.getTime() - 12 * 3_600_000, earliest.getTime()),
        ),
        new Date(
          Math.min(anchor.getTime() + 36 * 3_600_000, horizonEnd.getTime()),
        ),
        timeZone,
        null,
        null,
      )
    )
      .filter(inBudget)
      .map(judge)
      .filter((r) => isOffer(r.state) && !requested.some((q) => q.id === r.id))
      .sort(
        (a, b) =>
          Number(variantIds.includes(b.variantId)) -
            Number(variantIds.includes(a.variantId)) ||
          Math.abs(a.startsAt.getTime() - anchor.getTime()) -
            Math.abs(b.startsAt.getTime() - anchor.getTime()) ||
          a.id.localeCompare(b.id),
      );
    alternatives = near.slice(0, ALTERNATIVES);
    if (!alternatives.length) {
      const later = (
        await findSlots(
          db,
          companyId,
          siblings,
          earliest,
          horizonEnd,
          timeZone,
          null,
          null,
        )
      )
        .filter(inBudget)
        .map(judge)
        .find((r) => isOffer(r.state) && !requested.some((q) => q.id === r.id));
      if (later) alternatives = [later];
    }
  }

  const shown = requested.slice(
    0,
    Math.max(0, EVIDENCE_CAP - alternatives.length),
  );
  const used = [...shown, ...alternatives];
  if (!used.length) return { ...result, slotOutcome: outcome, query, timeZone };

  const base = new Map(
    (
      await input.variantEvidence([...new Set(used.map((r) => r.variantId))])
    ).map((e) => [e.variantId, e]),
  );
  const evidence: ProductEvidence[] = used.flatMap((row) => {
    const variant = base.get(row.variantId);
    if (!variant) return [];
    const slot: SlotEvidence = {
      slotId: row.id,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt?.toISOString() ?? null,
      state: row.state,
      seatsLeft: row.seatsLeft,
      role: alternatives.includes(row) ? 'ALTERNATIVE' : 'REQUESTED',
    };
    const priced = roundPrice(row);
    return [
      {
        ...variant,
        ref: `SLOT:${row.id}`,
        slot,
        price: priced.price,
        maxPrice: priced.maxPrice,
        priceNote: priced.priceNote,
        // A discount is about the variant's own price, not this round's.
        ...(row.price !== null
          ? { effectiveCompareAtPrice: null, discountAmount: null }
          : {}),
      },
    ];
  });
  const truncated = requested.length > shown.length;
  return {
    ...result,
    status: 'FOUND',
    evidence,
    choices: [],
    slotOutcome: outcome,
    query,
    timeZone,
    truncated: truncated || result.truncated,
    ...(truncated && requested.length
      ? {
          slotSummary: {
            count: requested.length,
            // Earliest and latest time of day, so a timetable over several
            // days is not described by its first and last departures only.
            first: [...requested]
              .map((r) => localTime(r.startsAt, timeZone))
              .sort()[0],
            last: [...requested]
              .map((r) => localTime(r.startsAt, timeZone))
              .sort()
              .at(-1)!,
          },
        }
      : {}),
  };
}

/** The moment alternatives are measured from: the asked time, else the window start. */
function anchorOf(
  query: { date: string | null; after: string | null; before: string | null },
  windowStart: Date,
  timeZone: string,
): Date {
  if (!query.date) return windowStart;
  const clock = query.after ?? query.before;
  if (!clock) return windowStart;
  const [hour, minute] = clock.split(':').map(Number);
  const asked = zonedToUtc(
    { ...addLocalDays(query.date, 0), hour, minute },
    timeZone,
  );
  // A +/-30 minute window is centred on the time the customer named.
  return query.after && query.before
    ? new Date(asked.getTime() + 30 * 60_000)
    : asked;
}
