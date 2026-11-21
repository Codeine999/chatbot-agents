import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommerceFeatureService } from '../../commerce/commerce-feature.service';
import {
  productCompanyScope,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import { lockProductPreset } from '../attributes/product-attribute.service';
import { validateAttributeValues } from '../attributes/utils/attribute-value.util';
import { ProductCommandService } from '../product-command.service';
import { lockProduct } from '../product-lock';
import { loadCatalogFields } from '../search/catalog-fields';
import {
  BulkSlotsDto,
  GenerateSlotsDto,
  ListSlotsQueryDto,
  MAX_SLOTS_PER_COMMAND,
  PatchSlotDto,
  bulkSlotsSchema,
  generateSlotsSchema,
  patchSlotSchema,
} from './product-slot.dto';
import {
  addDays,
  bangkokToUtc,
  daysBetween,
  isoWeekday,
  parseLocalDate,
  sqlTimestamp,
} from './slot-time';

type SlotRow = {
  startsAt: Date;
  endsAt: Date | null;
  capacity: number | null;
  meta: Record<string, unknown>;
};

/**
 * Dated occurrences of a variant (a bus departure, a class intake). Every
 * write is a catalog command: idempotent by requestId, shared preset lock then
 * the product row lock. Slots are not part of the product document, so
 * nothing here touches searchRevision or the vector index.
 */
@Injectable()
export class ProductSlotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: ProductCommandService,
    private readonly features: CommerceFeatureService,
  ) {}

  /** Expands a weekly pattern into rows; existing rows are never changed or reopened. */
  async generate(
    scopeInput: CommerceScope,
    actorAdminId: string,
    productId: string,
    variantId: string,
    input: GenerateSlotsDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const dto = generateSlotsSchema.parse(input);
    const rows = expandWeeklyPattern(dto);
    if (rows.length > MAX_SLOTS_PER_COMMAND)
      throw new BadRequestException(
        `Pattern expands to ${rows.length} rows; at most ${MAX_SLOTS_PER_COMMAND} per command`,
      );
    return this.commands.execute(
      scope,
      actorAdminId,
      dto.requestId,
      'GENERATE_PRODUCT_SLOTS',
      { productId, variantId, ...dto },
      async (tx) => {
        const meta = await this.checkedMeta(tx, scope, dto.meta);
        await this.lockVariant(tx, scope, productId, variantId);
        const now = new Date();
        const created = await tx.productSlot.createMany({
          data: rows.map((row) => ({
            companyId: scope.companyId,
            variantId,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            capacity: row.capacity,
            availabilityAt: row.capacity === null ? null : now,
            price: dto.price,
            maxPrice: dto.price === null ? null : dto.maxPrice,
            meta: meta as Prisma.InputJsonObject,
          })),
          skipDuplicates: true,
        });
        return {
          variantId,
          requested: rows.length,
          created: created.count,
          existing: rows.length - created.count,
          firstStartsAt: rows[0]?.startsAt.toISOString() ?? null,
          lastStartsAt: rows.at(-1)?.startsAt.toISOString() ?? null,
        };
      },
    );
  }

  /**
   * Creates missing rows and updates existing ones with the fields the row
   * names (a field left out keeps its stored value, null clears capacity/endsAt).
   */
  async bulkUpsert(
    scopeInput: CommerceScope,
    actorAdminId: string,
    productId: string,
    variantId: string,
    input: BulkSlotsDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const dto = bulkSlotsSchema.parse(input);
    return this.commands.execute(
      scope,
      actorAdminId,
      dto.requestId,
      'BULK_UPSERT_PRODUCT_SLOTS',
      { productId, variantId, ...dto },
      async (tx) => {
        await this.lockVariant(tx, scope, productId, variantId);
        const rows: Record<string, unknown>[] = [];
        for (const row of dto.rows) {
          const meta = row.meta
            ? await this.checkedMeta(tx, scope, row.meta)
            : undefined;
          const item: Record<string, unknown> = {
            startsAt: sqlTimestamp(new Date(row.startsAt)),
          };
          if (row.endsAt !== undefined)
            item.endsAt = row.endsAt
              ? sqlTimestamp(new Date(row.endsAt))
              : null;
          if (row.capacity !== undefined) item.capacity = row.capacity;
          if (row.reserved !== undefined) item.reserved = row.reserved;
          if (row.status !== undefined) item.status = row.status;
          // The fare is a pair: a price without maxPrice makes the round exact.
          if (row.price !== undefined) {
            item.price = row.price;
            item.maxPrice = row.price === null ? null : (row.maxPrice ?? null);
          }
          if (meta !== undefined) item.meta = meta;
          rows.push(item);
        }
        const payload = JSON.stringify(rows);
        const updated = await tx.$executeRaw`
          UPDATE "productSlots" s SET
            "endsAt" = CASE WHEN r ? 'endsAt' THEN (r->>'endsAt')::timestamp ELSE s."endsAt" END,
            capacity = CASE WHEN r ? 'capacity' THEN (r->>'capacity')::int ELSE s.capacity END,
            reserved = CASE WHEN r ? 'reserved' THEN (r->>'reserved')::int ELSE s.reserved END,
            status = CASE WHEN r ? 'status' THEN (r->>'status')::"ProductSlotStatus" ELSE s.status END,
            price = CASE WHEN r ? 'price' THEN (r->>'price')::numeric ELSE s.price END,
            "maxPrice" = CASE WHEN r ? 'price' THEN (r->>'maxPrice')::numeric ELSE s."maxPrice" END,
            meta = CASE WHEN r ? 'meta' THEN s.meta || (r->'meta') ELSE s.meta END,
            "availabilityAt" = CASE
              WHEN r ? 'capacity' AND (r->>'capacity') IS NULL THEN NULL
              WHEN r ? 'capacity' OR r ? 'reserved' THEN now() AT TIME ZONE 'UTC'
              ELSE s."availabilityAt" END,
            version = s.version + 1,
            "updatedAt" = now() AT TIME ZONE 'UTC'
          FROM jsonb_array_elements(${payload}::jsonb) r
          WHERE s."variantId" = ${variantId}::uuid
            AND s."companyId" = ${scope.companyId}::uuid
            AND s."startsAt" = (r->>'startsAt')::timestamp`;
        const inserted = await tx.$executeRaw`
          INSERT INTO "productSlots"
            (id, "companyId", "variantId", "startsAt", "endsAt", status, capacity,
             reserved, "availabilityAt", price, "maxPrice", meta, "updatedAt")
          SELECT gen_random_uuid(), ${scope.companyId}::uuid, ${variantId}::uuid,
            (r->>'startsAt')::timestamp,
            (r->>'endsAt')::timestamp,
            COALESCE((r->>'status')::"ProductSlotStatus", 'OPEN'),
            (r->>'capacity')::int,
            COALESCE((r->>'reserved')::int, 0),
            CASE WHEN (r->>'capacity') IS NOT NULL THEN now() AT TIME ZONE 'UTC' END,
            (r->>'price')::numeric,
            (r->>'maxPrice')::numeric,
            COALESCE(r->'meta', '{}'::jsonb),
            now() AT TIME ZONE 'UTC'
          FROM jsonb_array_elements(${payload}::jsonb) r
          ON CONFLICT ("variantId", "startsAt") DO NOTHING`;
        return { variantId, created: inserted, updated };
      },
    );
  }

  /** Close/cancel/reopen a slot or correct its seats; stale writers get 409. */
  async patch(
    scopeInput: CommerceScope,
    actorAdminId: string,
    productId: string,
    variantId: string,
    slotId: string,
    input: PatchSlotDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const dto = patchSlotSchema.parse(input);
    return this.commands.execute(
      scope,
      actorAdminId,
      dto.requestId,
      'PATCH_PRODUCT_SLOT',
      { productId, variantId, slotId, ...dto },
      async (tx) => {
        await this.lockVariant(tx, scope, productId, variantId);
        const locked = await tx.$queryRaw<
          { id: string; version: number; meta: Record<string, unknown> }[]
        >`
          SELECT id, version, meta FROM "productSlots"
          WHERE id = ${slotId}::uuid AND "variantId" = ${variantId}::uuid
            AND "companyId" = ${scope.companyId}::uuid FOR UPDATE`;
        const slot = locked[0];
        if (!slot) throw new NotFoundException('Slot not found');
        if (slot.version !== dto.expectedVersion)
          throw new ConflictException('Slot version changed');
        const data: Prisma.ProductSlotUpdateInput = {
          version: { increment: 1 },
        };
        if (dto.status !== undefined) data.status = dto.status;
        if (dto.capacity !== undefined) data.capacity = dto.capacity;
        if (dto.reserved !== undefined) data.reserved = dto.reserved;
        if (dto.endsAt !== undefined)
          data.endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
        // The fare is a pair: a price without maxPrice makes the round exact,
        // a null price hands the round back to the variant's fare.
        if (dto.price !== undefined) {
          data.price = dto.price;
          data.maxPrice = dto.price === null ? null : (dto.maxPrice ?? null);
        }
        // Unknown seats (capacity null) have nothing confirmed; any other seat edit confirms now.
        if (dto.capacity === null) data.availabilityAt = null;
        else if (dto.capacity !== undefined || dto.reserved !== undefined)
          data.availabilityAt = new Date();
        if (dto.meta !== undefined) {
          const checked = await this.checkedMeta(
            tx,
            scope,
            dto.meta,
            slot.meta,
          );
          data.meta = checked as Prisma.InputJsonObject;
        }
        const updated = await tx.productSlot.update({
          where: { id: slotId, companyId: scope.companyId },
          data,
        });
        if (
          updated.endsAt &&
          updated.endsAt.getTime() <= updated.startsAt.getTime()
        )
          throw new BadRequestException('endsAt must be after startsAt');
        return slotView(updated);
      },
    );
  }

  async list(
    scopeInput: CommerceScope,
    variantId: string | undefined,
    input: ListSlotsQueryDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const query = ListSlotsQueryDto.schema.parse(input);
    const where: Prisma.ProductSlotWhereInput = {
      companyId: scope.companyId,
      ...(variantId ? { variantId } : {}),
      startsAt: {
        ...(query.from
          ? { gte: bangkokToUtc(parseLocalDate(query.from), 0, 0) }
          : {}),
        ...(query.to
          ? { lt: bangkokToUtc(addDays(parseLocalDate(query.to), 1), 0, 0) }
          : {}),
      },
    };
    const rows = await this.prisma.productSlot.findMany({
      where,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
    });
    return { data: rows.map(slotView) };
  }

  private async lockVariant(
    tx: Prisma.TransactionClient,
    scope: CommerceScope,
    productId: string,
    variantId: string,
  ) {
    // Same order as every catalog command: shared preset lock, then the product row.
    await lockProductPreset(tx, scope, 'shared');
    await lockProduct(tx, scope, productId);
    const variant = await tx.productVariant.findFirst({
      where: { id: variantId, productId, companyId: scope.companyId },
      select: { id: true },
    });
    if (!variant) throw new NotFoundException('Product variant not found');
  }

  /** Slot values must be fields the preset declares for slots; prices/quantities never are. */
  private async checkedMeta(
    tx: Prisma.TransactionClient,
    scope: CommerceScope,
    values: Record<string, unknown>,
    stored: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!Object.keys(values).length && !Object.keys(stored).length) return {};
    const definitions = await loadCatalogFields(tx, scope);
    const kept = { ...stored };
    for (const [key, value] of Object.entries(values))
      if (value === null) delete kept[key];
    return validateAttributeValues({
      definitions,
      scope: 'SLOT',
      category: null,
      values: {
        ...kept,
        ...Object.fromEntries(
          Object.entries(values).filter(([, value]) => value !== null),
        ),
      },
      stored: {},
      enforceRequired: false,
    });
  }
}

function expandWeeklyPattern(dto: GenerateSlotsDto): SlotRow[] {
  const from = parseLocalDate(dto.from);
  const span = daysBetween(from, parseLocalDate(dto.to));
  const times = [...dto.times].sort();
  const rows: SlotRow[] = [];
  for (let offset = 0; offset <= span; offset += 1) {
    const date = addDays(from, offset);
    if (!dto.days.includes(isoWeekday(date))) continue;
    for (const time of times) {
      const [hour, minute] = time.split(':').map(Number);
      const startsAt = bangkokToUtc(date, hour, minute);
      rows.push({
        startsAt,
        endsAt:
          dto.durationMin === null
            ? null
            : new Date(startsAt.getTime() + dto.durationMin * 60_000),
        capacity: dto.capacity,
        meta: {},
      });
    }
  }
  return rows;
}

function slotView(slot: {
  id: string;
  variantId: string;
  startsAt: Date;
  endsAt: Date | null;
  status: string;
  capacity: number | null;
  reserved: number;
  availabilityAt: Date | null;
  price: Prisma.Decimal | null;
  maxPrice: Prisma.Decimal | null;
  meta: Prisma.JsonValue;
  version: number;
}) {
  return {
    id: slot.id,
    variantId: slot.variantId,
    startsAt: slot.startsAt.toISOString(),
    endsAt: slot.endsAt?.toISOString() ?? null,
    status: slot.status,
    capacity: slot.capacity,
    reserved: slot.reserved,
    availabilityAt: slot.availabilityAt?.toISOString() ?? null,
    /** null = the variant's price applies. */
    price: slot.price?.toFixed(2) ?? null,
    maxPrice: slot.maxPrice?.toFixed(2) ?? null,
    meta: slot.meta,
    version: slot.version,
  };
}
