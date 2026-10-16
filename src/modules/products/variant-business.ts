import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { z } from 'zod';
import { loadCatalogFields } from './search/catalog-fields';
import { validateAttributeValues } from './attributes/attribute-definition';
import {
  getBusinessProfile,
  physicalBusinessProfiles,
} from './business/business-registry';

const field = z.string().trim().min(1).max(100);
export const fashionFields = z
  .object({
    color: field.optional(),
    size: field.optional(),
    condition: field.optional(),
  })
  .strict();
export const restaurantFields = z
  .object({ portion: field.optional(), spiceLevel: field.optional() })
  .strict();
export const hotelFields = z
  .object({
    bedType: field.optional(),
    maxGuests: z.number().int().min(1).max(10000).optional(),
    roomArea: z
      .string()
      .regex(/^(?:[1-9]\d{0,7}|0)(?:\.\d{1,2})?$/)
      .refine((v) => new Prisma.Decimal(v).gt(0))
      .optional(),
  })
  .strict();
export type BusinessInput = {
  fashion?: z.infer<typeof fashionFields>;
  restaurant?: z.infer<typeof restaurantFields>;
  hotel?: z.infer<typeof hotelFields>;
  meta?: unknown;
};
export const businessInclude = {
  fashion: true,
  restaurant: true,
  hotel: true,
} as const;

export function businessStorage(type: string | null, key: string) {
  const profile = getBusinessProfile(type);
  const field = profile.columns[key];
  return field && profile.relation
    ? { object: profile.relation, field }
    : { object: 'meta', field: key };
}

export function coreVariant<T extends BusinessInput>(input: T) {
  const { fashion, restaurant, hotel, ...core } = input;
  void fashion;
  void restaurant;
  void hotel;
  return core;
}

export function variantAttributes(
  variant: {
    meta?: unknown;
    fashion?: {
      color?: string | null;
      size?: string | null;
      condition?: string | null;
    } | null;
    restaurant?: { portion?: string | null; spiceLevel?: string | null } | null;
    hotel?: {
      bedType?: string | null;
      maxGuests?: number | null;
      roomArea?: string | Prisma.Decimal | null;
    } | null;
  },
  type?: string | null,
): Record<string, unknown> {
  const result = {
    ...(variant.meta && typeof variant.meta === 'object' ? variant.meta : {}),
  } as Record<string, unknown>;
  // For a selected physical business, only its detail row is authoritative.
  // Undefined type is reserved for normalizing mutation input before validation.
  for (const key of Object.keys(getBusinessProfile(type ?? null).columns))
    delete result[key];
  for (const profile of physicalBusinessProfiles) {
    if (!profile.relation || (type !== undefined && type !== profile.type))
      continue;
    const row = variant[profile.relation];
    if (!row) continue;
    for (const [key, column] of Object.entries(profile.columns)) {
      const value: unknown = (row as Record<string, unknown>)[column];
      if (value != null)
        result[key] = key === 'room_area' ? Number(value) : value;
    }
  }
  return result;
}

/** Typed rows and core variant writes run under the same parent/definition locks and transaction. */
export async function saveBusiness(
  tx: Prisma.TransactionClient,
  companyId: string,
  variantId: string,
  category: string | null,
  input: BusinessInput,
) {
  const company = await tx.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { productBusinessType: true },
  });
  const type = company.productBusinessType;
  const supplied = [
    ['FASHION', input.fashion],
    ['RESTAURANT', input.restaurant],
    ['HOTEL', input.hotel],
  ] as const;
  for (const [expected, details] of supplied)
    if (details !== undefined && expected !== type)
      throw new ConflictException(
        `Select ${expected} before saving these variant fields`,
      );
  const attrs = variantAttributes(input);
  const pick = (keys: string[]) =>
    Object.fromEntries(
      keys
        .filter((key) => attrs[key] !== undefined)
        .map((key) => [key, attrs[key]]),
    );
  const keys =
    type === 'FASHION'
      ? ['color', 'size', 'condition']
      : type === 'RESTAURANT'
        ? ['portion', 'spice_level']
        : type === 'HOTEL'
          ? ['bed_type', 'max_guests', 'room_area']
          : [];
  const values = pick(keys);
  // Avoid two different values for the same business field in a single command.
  const original =
    input.meta && typeof input.meta === 'object'
      ? (input.meta as Record<string, unknown>)
      : {};
  for (const key of keys)
    if (original[key] !== undefined && attrs[key] !== original[key])
      throw new BadRequestException(`Conflicting variant field: ${key}`);
  if (!Object.keys(values).length) return;
  validateAttributeValues({
    definitions: await loadCatalogFields(tx, {
      companyId,
    }),
    scope: 'VARIANT',
    category,
    values,
    enforceRequired: false,
  });
  const where = { variantId_companyId: { variantId, companyId } };
  if (type === 'FASHION') {
    const data = fashionFields.parse(values);
    await tx.fashionVariant.upsert({
      where,
      create: { variantId, companyId, ...data },
      update: data,
    });
  } else if (type === 'RESTAURANT') {
    const data = restaurantFields.parse({
      portion: values.portion,
      spiceLevel: values.spice_level,
    });
    await tx.restaurantVariant.upsert({
      where,
      create: { variantId, companyId, ...data },
      update: data,
    });
  } else if (type === 'HOTEL') {
    const data = hotelFields.parse({
      bedType: values.bed_type,
      maxGuests: values.max_guests,
      roomArea:
        typeof values.room_area === 'number' ||
        typeof values.room_area === 'string'
          ? String(values.room_area)
          : undefined,
    });
    await tx.hotelVariant.upsert({
      where,
      create: { variantId, companyId, ...data },
      update: data,
    });
  }
  // A business field has one authoritative value in its typed row, not a stale JSON copy.
  await tx.$executeRaw`UPDATE "productVariants" SET meta = meta - ${Object.keys(values)}::text[]
    WHERE id=${variantId}::uuid AND "companyId"=${companyId}::uuid`;
}

export function variantAttributesSql(selectedOnly = false): Prisma.Sql {
  // Table/column identifiers are code-owned registry entries, never request input.
  const profiles = physicalBusinessProfiles.filter(
    (profile) => profile.relation,
  );
  const attributes = selectedOnly
    ? Prisma.sql`(v.meta - COALESCE((SELECT CASE c."productBusinessType" ${Prisma.join(
        profiles.map(
          (profile) =>
            Prisma.sql`WHEN ${profile.type} THEN ${Object.keys(profile.columns)}::text[]`,
        ),
        ' ',
      )} ELSE ARRAY[]::text[] END FROM company c WHERE c.id=v."companyId"), ARRAY[]::text[]))`
    : Prisma.sql`v.meta`;
  const detailRows = profiles.map((profile) => {
    const pairs = Object.entries(profile.columns).flatMap(([key, column]) => [
      Prisma.sql`${key}::text`,
      Prisma.raw(`d."${column}"`),
    ]);
    const selected = selectedOnly
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM company c WHERE c.id=v."companyId" AND c."productBusinessType"=${profile.type})`
      : Prisma.empty;
    return Prisma.sql`COALESCE((SELECT jsonb_strip_nulls(jsonb_build_object(${Prisma.join(pairs)})) FROM ${Prisma.raw(`"${profile.relation}Variants"`)} d WHERE d."variantId"=v.id AND d."companyId"=v."companyId" ${selected}), '{}'::jsonb)`;
  });
  return Prisma.sql`${attributes} || ${Prisma.join(detailRows, ' || ')}`;
}
