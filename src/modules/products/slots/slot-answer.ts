import { catalogCapabilities, catalogLexicon } from '../search/catalog-fields';
import { DEFAULT_PRICE_WORDING, formatPrice } from '../product-pricing';
import type {
  ProductEvidence,
  ProductWorkflow,
} from '../search/product-search.types';
import {
  availabilityLabel,
  formatArrival,
  formatClock,
  formatLocalDate,
  formatQueryTime,
  formatSlotDate,
  formatSlotTime,
  slotClock,
  slotLocalDate,
} from './slot-format';
import type { BusinessLexicon } from '../attributes/types/attribute-definition.types';

/** What the customer asked about a timetable, decided from the plan alone. */
export function slotAsks(plan: ProductWorkflow['plan']) {
  const asks = new Set(plan.asks);
  return {
    schedule:
      asks.has('SCHEDULE') ||
      plan.operation === 'NEXT' ||
      (plan.when ?? null) !== null,
    availability: asks.has('STOCK') || (plan.quantity ?? null) !== null,
    price: asks.has('PRICE') || asks.has('SCHEDULE'),
  };
}

/**
 * The timetable answer, written by code from the slot evidence only: times,
 * dates, prices and availability all come from the database rows, so there is
 * nothing for a model to invent. Used directly for plain lookups and as the
 * safe answer whenever a model template is rejected.
 */
export function scheduleAnswer(workflow: ProductWorkflow): string {
  const { result, plan } = workflow;
  const lexicon = catalogLexicon(result.businessType);
  const capabilities = catalogCapabilities(result.businessType);
  const texts = lexicon.schedule;
  const zone = result.timeZone;
  const query = result.query;
  const asks = slotAsks(plan);
  if (!texts) return lexicon.clarify.notFound;

  const fill = (template: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [key, value]) => text.replaceAll(`{${key}}`, value),
      template,
    );
  if (result.slotOutcome === 'OUT_OF_WINDOW')
    return fill(lexicon.clarify.outOfWindow ?? lexicon.clarify.notFound, {
      date: query?.date ? formatLocalDate(query.date) : '',
      days: String(capabilities.slot?.horizonDays ?? ''),
    });

  const rows = result.evidence.filter((e) => e.slot);
  const whenText = [
    query?.date ? ` ${formatLocalDate(query.date)}` : '',
    formatQueryTime(query?.after ?? null, query?.before ?? null)
      ? ` ${formatQueryTime(query?.after ?? null, query?.before ?? null)}`
      : '',
  ].join('');
  const line = (e: ProductEvidence, withDate: boolean) => {
    const slot = e.slot!;
    const parts = [
      `${withDate ? `${formatSlotDate(slot.startsAt, zone)} ` : ''}${formatSlotTime(slot.startsAt, zone)}`,
    ];
    if (slot.endsAt && asks.schedule)
      parts.push(
        fill(texts.arrive, {
          arrive: formatArrival(slot.startsAt, slot.endsAt, zone),
        }),
      );
    if (asks.price && e.price !== null)
      parts.push(formatPrice(e, lexicon.price ?? DEFAULT_PRICE_WORDING));
    // A full or closed round is always said so; the rest only when availability was asked.
    if (asks.availability || slot.state === 'FULL' || slot.state === 'CLOSED') {
      parts.push(
        availabilityLabel(
          lexicon,
          capabilities.showQuantity,
          slot,
          query?.quantity ?? null,
        ),
      );
      if (
        asks.availability &&
        capabilities.showQuantity &&
        slot.seatsLeft !== null &&
        (slot.state === 'AVAILABLE' || slot.state === 'LOW')
      )
        parts.push(
          fill(texts.left, {
            left: String(slot.seatsLeft),
            unit: lexicon.unit,
          }),
        );
    }
    return `• ${parts.join(' · ')}`;
  };

  const blocks: string[] = [];
  const names = [...new Set(result.evidence.map((e) => e.name))];
  const requested = rows.filter((e) => e.slot!.role === 'REQUESTED');
  const alternatives = rows.filter((e) => e.slot!.role === 'ALTERNATIVE');
  // One day of one product, asked about times only: the departure layout.
  if (
    !asks.availability &&
    texts.mainTitle &&
    requested.length &&
    alternatives.length === 0 &&
    new Set(requested.map((e) => e.productId)).size === 1 &&
    new Set(requested.map((e) => slotLocalDate(e.slot!.startsAt, zone)))
      .size === 1
  )
    return departureTimetable(requested, texts, zone);
  if (requested.length) {
    const byProduct = new Map<string, ProductEvidence[]>();
    for (const e of requested)
      byProduct.set(e.productId, [...(byProduct.get(e.productId) ?? []), e]);
    for (const list of byProduct.values()) {
      const title = fill(
        plan.operation === 'NEXT' ? texts.nextTitle : texts.title,
        { name: list[0].name },
      );
      const head =
        title +
        (query?.date ? ` ${formatLocalDate(query.date)}` : '') +
        (query?.quantity
          ? fill(texts.forQuantity, { quantity: String(query.quantity) })
          : '');
      blocks.push([head, ...list.map((e) => line(e, !query?.date))].join('\n'));
    }
  } else if (result.evidence.length || names.length) {
    blocks.push(
      fill(lexicon.clarify.noSlot ?? lexicon.clarify.notFound, {
        name: names.join(' / '),
        when: whenText ? `${whenText} ` : ' ',
      }),
    );
  }
  if (alternatives.length)
    blocks.push(
      [texts.alternatives, ...alternatives.map((e) => line(e, true))].join(
        '\n',
      ),
    );
  if (result.slotSummary)
    blocks.push(
      fill(texts.summary, {
        count: String(result.slotSummary.count),
        first: formatClock(result.slotSummary.first),
        last: formatClock(result.slotSummary.last),
      }) +
        (query?.date
          ? ''
          : lexicon.clarify.when
            ? `\n${lexicon.clarify.when}`
            : ''),
    );
  return blocks.join('\n\n') || lexicon.clarify.notFound;
}

/**
 * The one-day timetable as a bus company prints it: a title, one line per
 * departure place with its times, the price of the listed rounds and a notice.
 * Places come from the origin fact; every number is read from the rows.
 */
function departureTimetable(
  rows: ProductEvidence[],
  texts: NonNullable<BusinessLexicon['schedule']>,
  zone: string | undefined,
): string {
  const first = rows[0];
  const [fromName = first.name, toName = ''] = first.name.split('→');
  const fact = (key: string, fallback: string) =>
    first.details.find((d) => d.key === key)?.value ?? fallback;
  const origin = fact('origin', fromName.trim());
  const destination = fact('destination', toName.trim());
  const date = formatLocalDate(slotLocalDate(first.slot!.startsAt, zone));
  const times = [...rows]
    .sort((a, b) => a.slot!.startsAt.localeCompare(b.slot!.startsAt))
    .map((e) => slotClock(e.slot!.startsAt, zone));
  const prices = rows.flatMap((e) =>
    e.price === null ? [] : [Number(e.price), Number(e.maxPrice ?? e.price)],
  );
  const money = (value: number) =>
    value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const priceLine =
    prices.length === 0
      ? ''
      : low === high && rows.every((e) => e.maxPrice == null)
        ? fillText(texts.priceFixed ?? '', { price: money(low) })
        : fillText(texts.priceRange ?? '', {
            min: money(low),
            max: money(high),
          });
  return [
    fillText(texts.mainTitle ?? '', { origin, destination }) + ` (${date})`,
    fillText(texts.departure ?? '', {
      place: origin,
      times: times.join(', '),
    }),
    priceLine,
    texts.notice ?? '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

const fillText = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );

/**
 * A pure timetable lookup (time, seats, price of named/filtered routes) needs
 * no model: the answer is written from the slot rows. Comparisons,
 * recommendations, detail/policy questions still go through the model template.
 */
export function isScheduleLookup(workflow: ProductWorkflow): boolean {
  const { plan, result } = workflow;
  if (
    plan.mode !== 'PRODUCT' ||
    result.status !== 'FOUND' ||
    result.slotOutcome === undefined
  )
    return false;
  if (!['LIST', 'NEXT', 'DETAIL'].includes(plan.operation)) return false;
  if (plan.listOptions.length || plan.askFields?.length) return false;
  const lookupAsks = new Set(['SCHEDULE', 'STOCK', 'PRICE']);
  if (plan.asks.some((ask) => !lookupAsks.has(ask))) return false;
  return plan.asks.length > 0 || plan.operation === 'NEXT';
}
