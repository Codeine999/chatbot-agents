import { variantAttributes } from '../variant-business';
import { Injectable, Optional, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeText, redactPii } from '../../../utils/text.utils';
import { bm25Scores } from '../../chatbot/knowledge/utils/thai-bm25';
import {
  productCompanyScope,
  productWhere,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import type { EmbeddingResult } from '../../../infra/embedding/embedding-adapter.interface';
import { ProductVectorRepository } from './product-vector.repository';
import { loadCatalogFields, loadCatalogContext } from './catalog-fields';
import {
  fieldOperators,
  matchesBusinessFields,
  validateBusinessFilters,
} from '../business/business-match';
import {
  formatAttributeValue,
  appliesToCategory,
} from '../attributes/utils/attribute-value.util';
import type { AttributeDefinition } from '../attributes/types/attribute-definition.types';
import type {
  ProductPlan,
  ProductSearchResult,
  ProductEvidence,
} from './product-search.types';
import {
  labelledAttributes,
  stableProductDescription,
} from './product-document';
import { productContentTerms } from './product-terms';
import { hasCatalogConstraints } from './product-plan-policy';
import { productDiscount } from '../product-pricing';

const include = {
  company: { select: { productBusinessType: true } },
  variants: {
    where: { active: true },
    include: { inventory: true },
    orderBy: { sku: 'asc' as const },
  },
};
type ProductRecord = Prisma.ProductGetPayload<{ include: typeof include }>;

/** Values of the store's searchable product-level fields (e.g. brand), as text. */
function searchableValues(keys: readonly string[]): Prisma.Sql {
  return Prisma.sql`COALESCE((SELECT string_agg(e.value, ' ') FROM "productVariants" v CROSS JOIN LATERAL jsonb_each_text(v.meta) e WHERE v."productId"=p.id AND v."companyId"=p."companyId" AND v.active AND e.key = ANY(${[...keys]}::text[])), '')`;
}

/**
 * Number of subject terms found in a product's identifying fields: name,
 * sku, aliases, category and searchable fields such as brand (not prose).
 */
function identityHits(
  terms: readonly string[],
  keys: readonly string[],
): Prisma.Sql {
  return terms.length
    ? Prisma.join(
        terms.map(
          (term) =>
            Prisma.sql`(CASE WHEN position(lower(${term}) in lower(concat_ws(' ', p.name, array_to_string(p.aliases, ' '), p.category, ${searchableValues(keys)}))) > 0 THEN 1 ELSE 0 END)`,
        ),
        ' + ',
      )
    : Prisma.sql`0`;
}

const searchableProductKeys = (definitions: readonly AttributeDefinition[]) =>
  definitions
    .filter((d) => !d.variantOption && d.status === 'ACTIVE' && d.searchable)
    .map((d) => d.key);
/** Field labels and extracted option values describe a variant, not which product. */
const nonSubjectWords = (
  plan: Pick<ProductPlan, 'options' | 'filters'>,
  definitions: readonly AttributeDefinition[],
) => [
  ...plan.options.map((o) => o.value),
  ...plan.filters.map((f) => String(f.value)),
  ...definitions.map((d) => d.label),
];

function mentionsSku(query: string, sku: string): boolean {
  const escaped = sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_.-])${escaped}($|[^a-z0-9_.-])`, 'iu').test(
    query,
  );
}

@Injectable()
export class ProductSearchService {
  private readonly vectorMin: number;
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectors: ProductVectorRepository,
    @Optional() config?: ConfigService,
  ) {
    this.vectorMin = z.coerce
      .number()
      .min(0)
      .max(1)
      .parse(config?.get('PRODUCT_VECTOR_MIN_SIMILARITY') ?? 0.65);
  }

  async probe(
    scopeInput: CommerceScope,
    query: string,
    language = 'th',
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const scope = productCompanyScope(scopeInput);
    // Match complete catalog identifiers/names in the question, with sku boundaries.
    const rows = await db.$queryRaw<
      {
        id: string;
        name: string;
        aliases: string[];
        skus: string[];
        variantIds: string[];
      }[]
    >`
      SELECT p.id, p.name, p.aliases, array_agg(v.sku ORDER BY v.sku) AS skus, array_agg(v.id ORDER BY v.sku) AS "variantIds"
      FROM products p JOIN "productVariants" v ON v."productId"=p.id AND v."companyId"=p."companyId" AND v.active
      WHERE p."companyId"=${scope.companyId}::uuid AND p.status='ACTIVE' AND p.language=${language}
        AND (position(lower(v.sku) in lower(${query}))>0
          OR position(lower(p.name) in lower(${query}))>0
          OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE length(a)>=2 AND position(lower(a) in lower(${query}))>0))
      GROUP BY p.id ORDER BY p.id LIMIT 21`;
    const normalized = normalizeText(query);
    const skuHit = (sku: string) => mentionsSku(query, sku);
    return rows.filter(
      (row) =>
        row.skus.some(skuHit) ||
        normalized.includes(normalizeText(row.name)) ||
        row.aliases.some(
          (a) => a.length >= 2 && normalized.includes(normalizeText(a)),
        ),
    );
  }

  /**
   * Cheap routing signal: does the message name something the catalog sells
   * (product name, alias, sku or category)? Descriptions are excluded so a
   * policy question cannot match prose such as "ส่งไว".
   */
  async mentionsCatalog(
    scopeInput: CommerceScope,
    message: string,
    language = 'th',
  ): Promise<boolean> {
    const scope = productCompanyScope(scopeInput);
    const definitions = await loadCatalogFields(this.prisma, scope);
    const terms = productContentTerms(
      message,
      definitions.map((d) => d.label),
    );
    if (!terms.length) return false;
    const rows = await this.prisma.$queryRaw<{ hit: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM products p WHERE p."companyId"=${scope.companyId}::uuid
        AND p.status='ACTIVE' AND p.language=${language}
        AND (${identityHits(terms, searchableProductKeys(definitions))}) > 0
      ) AS hit`;
    return rows[0]?.hit === true;
  }

  /**
   * What the planner may extract: the store's customer-choice fields with
   * sample real values (so "256" can map to "256GB"), and its categories.
   */
  async plannerCatalog(scopeInput: CommerceScope, language = 'th') {
    const scope = productCompanyScope(scopeInput);
    const catalog = await loadCatalogContext(this.prisma, scope);
    const definitions = catalog.fields.filter(
      (d) =>
        d.scope === 'VARIANT' &&
        d.status === 'ACTIVE' &&
        d.searchable &&
        d.aiVisible,
    );
    const values = definitions.length
      ? await this.prisma.$queryRaw<{ key: string; values: string[] }[]>`
          SELECT e.key, (array_agg(DISTINCT e.value ORDER BY e.value))[1:30] AS values
          FROM products p
          JOIN "productVariants" v ON v."productId"=p.id AND v."companyId"=p."companyId" AND v.active
          CROSS JOIN LATERAL jsonb_each_text(v.meta) e
          WHERE p."companyId"=${scope.companyId}::uuid AND p.status='ACTIVE' AND p.language=${language}
            AND e.key = ANY(${definitions.map((d) => d.key)}::text[])
          GROUP BY e.key`
      : [];
    const categories = await this.prisma.product.findMany({
      where: {
        ...productWhere(scope),
        status: 'ACTIVE',
        language,
        category: { not: null },
      },
      distinct: ['category'],
      select: { category: true },
      take: 50,
    });
    return {
      businessType: catalog.businessType,
      fields: definitions.map((d) => ({
        key: d.key,
        label: d.label,
        type: d.type,
        unit: d.unit,
        valueAliases: d.valueAliases,
        operators: fieldOperators(d),
        values: values.find((v) => v.key === d.key)?.values ?? d.options,
      })),
      options: definitions
        .filter((d) => d.variantOption)
        .map((d) => ({
          key: d.key,
          label: d.label,
          values: values.find((v) => v.key === d.key)?.values ?? d.options,
        })),
      categories: categories.flatMap((c) => (c.category ? [c.category] : [])),
    };
  }

  async search(
    scopeInput: CommerceScope,
    plan: ProductPlan,
    embedding?: EmbeddingResult,
    language = 'th',
    expectedBusinessType?: string | null,
  ): Promise<ProductSearchResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const catalog = await loadCatalogContext(tx, scopeInput);
        if (
          expectedBusinessType !== undefined &&
          catalog.businessType !== expectedBusinessType
        )
          throw new ConflictException(
            'Product business changed during planning',
          );
        validateBusinessFilters(plan, catalog.fields);
        const result = await this.read(
          tx,
          scopeInput,
          plan,
          embedding,
          language,
          catalog,
        );
        return { ...result, businessType: catalog.businessType };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }

  private async read(
    db: Prisma.TransactionClient,
    scopeInput: CommerceScope,
    plan: ProductPlan,
    embedding: EmbeddingResult | undefined,
    language: string,
    catalog: Awaited<ReturnType<typeof loadCatalogContext>>,
  ): Promise<ProductSearchResult> {
    const scope = productCompanyScope(scopeInput);
    const definitions = catalog.fields;
    const attributeKeys = searchableProductKeys(definitions);
    // Variant choices select variants, never products; question words select nothing.
    const terms = productContentTerms(
      plan.query,
      nonSubjectWords(plan, definitions),
    );
    let ids = plan.productIds;
    let reliable = ids.length > 0;
    if (!ids.length && plan.operation === 'DETAIL') {
      const exact = await this.probe(scope, plan.query, language, db);
      if (exact.length > 1)
        return {
          status: 'MISSING_INPUT',
          evidence: [],
          choices: exact.slice(0, 5),
        };
      if (exact.length === 1) {
        ids = [exact[0].id];
        reliable = true;
      }
    }
    let vectorRows: { productId: string; score: number }[] = [];
    if (!ids.length && embedding)
      vectorRows = await this.vectors.search(
        scope,
        language,
        embedding.values,
        embedding.model,
        db,
      );
    const noSubject = !ids.length && !terms.length && !vectorRows.length;
    // "ราคาเท่าไร" alone names nothing to look up: ask which product, never scan or fail.
    if (noSubject && !hasCatalogConstraints(plan))
      return { status: 'MISSING_INPUT', evidence: [], choices: [] };
    const filters: Prisma.ProductWhereInput[] = [
      { ...productWhere(scope), status: 'ACTIVE', language },
    ];
    if (plan.category) filters.push(await this.categoryFilter(db, scope, plan));
    if (ids.length) filters.push({ id: { in: ids } });
    // Constraints without a subject ("ไม่เกิน 2000", "สีดำ") filter the whole catalog.
    const allCatalogOperation =
      ['LIST', 'COUNT', 'CHEAPEST'].includes(plan.operation) ||
      (!terms.length && plan.filters.length > 0) ||
      noSubject;
    // Aggregates scan the real catalog, never vector top-k, but stay on the
    // subject the customer named: "รองเท้าที่ถูกที่สุด" must not return a shirt.
    // Every subject term must match, because a count or "cheapest" claim about
    // a broader set ("หมวก" for "หมวกกันน็อก") would be a wrong store fact.
    if (allCatalogOperation && !ids.length && terms.length) {
      const subject = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT p.id FROM products p
        WHERE p."companyId"=${scope.companyId}::uuid
        AND p.status='ACTIVE' AND p.language=${language}
        AND (${identityHits(terms, attributeKeys)}) = ${terms.length}`);
      if (!subject.length)
        return { status: 'NO_MATCH', evidence: [], choices: [] };
      filters.push({ id: { in: subject.map((r) => r.id) } });
    }
    const records: ProductRecord[] = [];
    const hits = new Map<string, number>();
    if (!ids.length && !allCatalogOperation) {
      // Without terms only vector candidates remain; an empty lexical query is never sent.
      let lexicalRows: { id: string; hits: number }[] = [];
      if (terms.length) {
        const condition = Prisma.join(
          terms.map(
            (term) =>
              Prisma.sql`position(lower(${term}) in lower(concat_ws(' ', p.name, array_to_string(p.aliases,' '), p.description, p.category, ${searchableValues(attributeKeys)}))) > 0`,
          ),
          ' OR ',
        );
        const relevance = Prisma.join(
          terms.map(
            (term) =>
              Prisma.sql`CASE WHEN position(lower(${term}) in lower(concat_ws(' ',p.name,array_to_string(p.aliases,' ')))) > 0 THEN 4 WHEN position(lower(${term}) in lower(concat_ws(' ',p.description,p.category,${searchableValues(attributeKeys)}))) > 0 THEN 1 ELSE 0 END`,
          ),
          ' + ',
        );
        lexicalRows = await db.$queryRaw<{ id: string; hits: number }[]>(
          Prisma.sql`
          SELECT p.id, (${identityHits(terms, attributeKeys)})::int AS hits FROM products p WHERE p."companyId"=${scope.companyId}::uuid
          AND p.status='ACTIVE' AND p.language=${language}
          AND (${condition}) ORDER BY (${relevance}) DESC,p.id LIMIT 60`,
        );
      }
      for (const row of lexicalRows) hits.set(row.id, Number(row.hits));
      filters.push({
        id: {
          in: [
            ...new Set([
              ...lexicalRows.map((r) => r.id),
              ...vectorRows.map((r) => r.productId),
            ]),
          ],
        },
      });
    }
    // Keyset scanning makes aggregates complete without loading an unbounded catalog in one read.
    let after: string | undefined;
    let total = 0;
    let evidence: ProductEvidence[] = [];
    do {
      const page = await db.product.findMany({
        where: {
          AND: [...filters, ...(after ? [{ id: { gt: after } }] : [])],
        },
        take: allCatalogOperation ? 100 : 80,
        orderBy: { id: 'asc' },
        include,
      });
      if (!page.length) break;
      if (!allCatalogOperation) {
        records.push(...page);
        break;
      }
      for (const product of page) {
        const facts = this.evidence(product, plan, definitions);
        if (!facts.length) continue;
        total +=
          plan.operation === 'COUNT' && plan.countUnit === 'PRODUCTS'
            ? 1
            : facts.length;
        evidence.push(...facts);
        evidence = this.order(evidence, plan).slice(0, 12);
      }
      after = page[page.length - 1].id;
      if (page.length < 100) break;
    } while (allCatalogOperation);
    if (allCatalogOperation)
      // Zero is "nothing matched these filters", never "the store has none".
      return total
        ? {
            status: 'FOUND',
            evidence,
            choices: [],
            total,
            truncated: total > evidence.length,
          }
        : { status: 'NO_MATCH', evidence: [], choices: [] };
    // Score the same subject terms that selected candidates: a shared verb
    // ("ใส่") or question word must not rank an unrelated product.
    const lexical = bm25Scores(
      terms.join(' '),
      records.map((p) => ({
        title: p.name,
        keywords: [...p.variants.map((v) => v.sku), ...p.aliases],
        questionExamples: [],
        intentKey: null,
        category: p.category,
        description: p.description,
        answer: labelledAttributes(
          definitions,
          'VARIANT',
          Object.assign({}, ...p.variants.map((v) => variantAttributes(v))),
          'searchable',
        )
          .map((a) => a.value)
          .join(' '),
      })),
    );
    const lexicalOrder = records
      .map((p, i) => ({ id: p.id, score: lexical[i] }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const vectorOrder = vectorRows.filter((r) => r.score >= this.vectorMin);
    const fused = new Map<string, number>();
    for (const list of [
      lexicalOrder.map((r) => r.id),
      vectorOrder.map((r) => r.productId),
    ])
      list.forEach((id, rank) =>
        fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank + 1)),
      );
    // A substring hit on the name survives a Thai segmentation mismatch in BM25.
    let ranked = records
      .map((p) => ({
        p,
        score: fused.get(p.id) ?? 0,
        hits: hits.get(p.id) ?? 0,
      }))
      .filter((r) => reliable || r.score > 0 || r.hits > 0)
      .sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
    if (!reliable && plan.operation === 'DETAIL' && ranked.length > 1) {
      // Variant constraints settle ambiguity first ("เสื้อเชิ้ตผ้าลินิน" has
      // one linen shirt); if none satisfies them, keep all so the identified
      // product can still report VARIANT_UNAVAILABLE below.
      const satisfying = ranked.filter(
        (r) => this.evidence(r.p, plan, definitions).length > 0,
      );
      if (satisfying.length) ranked = satisfying;
      // The product whose name/alias/category covers strictly more of the
      // subject wins ("เสื้อลินิน" over every other "เสื้อ"); a tie stays a
      // question back to the customer, never a silent pick of rank one.
      const best = Math.max(...ranked.map((r) => r.hits));
      const leaders = best > 0 ? ranked.filter((r) => r.hits === best) : ranked;
      if (leaders.length !== 1)
        return {
          status: 'MISSING_INPUT',
          evidence: [],
          choices: leaders
            .slice(0, 5)
            .map((r) => ({ id: r.p.id, name: r.p.name })),
        };
      ranked = leaders;
    }
    if (!ranked.length)
      return {
        status: vectorRows.length ? 'NO_RELIABLE_CANDIDATE' : 'NO_MATCH',
        evidence: [],
        choices: [],
      };
    // Asking "which one?" needs a choice: one named product answers for all its variants.
    if (plan.ambiguous && ranked.length > 1)
      return {
        status: 'MISSING_INPUT',
        evidence: [],
        choices: ranked
          .slice(0, 5)
          .map((r) => ({ id: r.p.id, name: r.p.name })),
      };
    const selected = ranked.slice(0, plan.operation === 'DETAIL' ? 1 : 5);
    for (const row of selected)
      evidence.push(...this.evidence(row.p, plan, definitions));
    if (
      plan.operation === 'COMPARE' &&
      new Set(evidence.map((e) => e.variantId)).size < 2
    )
      return {
        status: 'MISSING_INPUT',
        evidence: [],
        choices: selected.map((r) => ({ id: r.p.id, name: r.p.name })),
      };
    if (!evidence.length) {
      // The product is known; only the requested option does not exist.
      // Say so with the real options instead of asking "which product?".
      const product = selected.length === 1 ? selected[0].p : undefined;
      if (
        product &&
        plan.options.length &&
        this.evidence(product, { ...plan, options: [] }, definitions).length
      )
        return {
          status: 'VARIANT_UNAVAILABLE',
          evidence: [],
          choices: [{ id: product.id, name: product.name }],
          options: definitions
            .filter(
              (d) =>
                d.scope === 'VARIANT' &&
                d.status === 'ACTIVE' &&
                d.variantOption &&
                d.aiVisible,
            )
            .map((d) => ({
              key: d.key,
              label: d.label,
              values: [
                ...new Set(
                  product.variants.flatMap((v) => {
                    const value = formatAttributeValue(
                      d,
                      variantAttributes(v)[d.key],
                    );
                    return value ? [value] : [];
                  }),
                ),
              ],
            }))
            .filter((o) => o.values.length),
        };
      return {
        status: 'MISSING_INPUT',
        evidence: [],
        choices: selected.map((r) => ({ id: r.p.id, name: r.p.name })),
      };
    }
    return {
      status: 'FOUND',
      evidence: this.order(evidence, plan).slice(0, 12),
      choices: [],
      identified: reliable,
      truncated: evidence.length > 12 || ranked.length > selected.length,
    };
  }

  /**
   * A store category the planner chose from storeCategories is the subject
   * itself, matched exactly ("shirt" must not include "t-shirt"). Free-text
   * categories ("เสื้อ" for a "เสื้อผ้า" category) still match loosely.
   */
  private async categoryFilter(
    db: Prisma.TransactionClient,
    scope: CommerceScope,
    plan: ProductPlan,
  ): Promise<Prisma.ProductWhereInput> {
    const category = plan.category!;
    const exact = { equals: category, mode: 'insensitive' as const };
    const stored = await db.product.findFirst({
      where: { ...productWhere(scope), category: exact },
      select: { id: true },
    });
    return stored
      ? { category: exact }
      : {
          OR: [
            { category: { contains: category, mode: 'insensitive' } },
            { name: { contains: category, mode: 'insensitive' } },
            { aliases: { has: category } },
          ],
        };
  }

  private evidence(
    product: ProductRecord,
    plan: ProductPlan,
    definitions: readonly AttributeDefinition[],
  ): ProductEvidence[] {
    // Every requested option must hold on the same variant row; an option the
    // store does not define matches nothing rather than being ignored.
    const visibleDefinitions = definitions.filter((d) =>
      appliesToCategory(d, product.category),
    );
    return product.variants
      .filter((variant) => {
        if (plan.variantIds.length && !plan.variantIds.includes(variant.id))
          return false;
        const values = variantAttributes(variant);
        return matchesBusinessFields(
          values,
          product.category,
          plan,
          definitions,
        );
      })
      .flatMap((variant) => {
        // SKU restricts one variant; constraints must all match that same row.
        const mentionedSkus = product.variants.filter((v) =>
          mentionsSku(plan.query, v.sku),
        );
        if (
          mentionedSkus.length &&
          !mentionedSkus.some((v) => v.id === variant.id)
        )
          return [];
        const price = variant.price;
        if (plan.operation === 'CHEAPEST' && !price) return [];
        if ((plan.minPrice || plan.maxPrice) && !price) return [];
        if (
          price &&
          ((plan.minPrice && price.lt(new Prisma.Decimal(plan.minPrice))) ||
            (plan.maxPrice && price.gt(new Prisma.Decimal(plan.maxPrice))))
        )
          return [];
        const stock = !variant.trackStock
          ? 'NOT_TRACKED'
          : !variant.inventory
            ? 'UNKNOWN'
            : variant.inventory.onHand > variant.inventory.reserved
              ? 'IN_STOCK'
              : 'OUT_OF_STOCK';
        if (plan.inStockOnly && stock !== 'IN_STOCK') return [];
        return [
          {
            ref: `PRODUCT:${variant.id}`,
            productId: product.id,
            variantId: variant.id,
            name: redactPii(product.name),
            category: product.category ? redactPii(product.category) : null,
            aliases: product.aliases.map(redactPii),
            sku: variant.sku,
            description: stableProductDescription(product.description).slice(
              0,
              2000,
            ),
            details: labelledAttributes(
              visibleDefinitions.filter((d) => !d.variantOption),
              'VARIANT',
              variantAttributes(variant),
              'aiVisible',
            ),
            options: labelledAttributes(
              visibleDefinitions.filter((d) => d.variantOption),
              'VARIANT',
              variantAttributes(variant),
              'aiVisible',
            ),
            price: price?.toFixed(2) ?? null,
            ...productDiscount(variant),
            currency: 'THB' as const,
            stock,
            onHand:
              variant.trackStock && variant.inventory
                ? variant.inventory.onHand
                : null,
            reserved:
              variant.trackStock && variant.inventory
                ? variant.inventory.reserved
                : null,
            availableStock:
              variant.trackStock && variant.inventory
                ? variant.inventory.onHand - variant.inventory.reserved
                : null,
            purchasable:
              price !== null && stock !== 'UNKNOWN' && stock !== 'OUT_OF_STOCK',
            fetchedAt: new Date().toISOString(),
            sourceRevision: product.revision,
          },
        ];
      });
  }

  private order(evidence: ProductEvidence[], plan: ProductPlan) {
    return plan.operation !== 'CHEAPEST'
      ? evidence
      : evidence
          .filter((e) => e.price !== null)
          .sort(
            (a, b) =>
              new Prisma.Decimal(a.price!).comparedTo(
                new Prisma.Decimal(b.price!),
              ) || a.sku.localeCompare(b.sku),
          );
  }
}
