import { variantAttributes } from './variant-business';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CommerceFeatureService } from '../commerce/commerce-feature.service';
import {
  productCompanyScope,
  productWhere,
  type CommerceScope,
} from '../commerce/types/commerce-scope';
import {
  CreateProductDto,
  CreateProductVariantDto,
  ListProductsQueryDto,
  UpdateProductDto,
  UpdateProductVariantDto,
} from './dto/product.dto';
import { ProductCommandService } from './product-command.service';
import { lockProduct } from './product-lock';
import { assertProductPricing, productDiscount } from './product-pricing';
import { loadCatalogFields } from './search/catalog-fields';
import { enqueueProductIndex } from './search/product-index-outbox';
import { lockProductPreset } from './attributes/product-attribute.service';
import { validateAttributeValues } from './attributes/utils/attribute-value.util';
import type {
  AttributeDefinition,
  AttributeScope,
} from './attributes/types/attribute-definition.types';

const catalogInclude = {
  company: { select: { productBusinessType: true } },
  variants: {
    orderBy: { id: 'asc' as const },
    include: { inventory: true },
  },
} satisfies Prisma.ProductInclude;
type CatalogRecord = Prisma.ProductGetPayload<{
  include: typeof catalogInclude;
}>;

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: ProductCommandService,
    private readonly features: CommerceFeatureService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async list(scopeInput: CommerceScope, input: ListProductsQueryDto) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const query = ListProductsQueryDto.schema.parse(input);
    const where: Prisma.ProductWhereInput = {
      ...productWhere(scope),
      status: query.status,
    };
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { aliases: { has: query.q } },
        {
          variants: {
            some: {
              companyId: scope.companyId,
              sku: { contains: query.q, mode: 'insensitive' },
            },
          },
        },
      ];
    }
    const [total, records] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        take: query.limit,
        skip: query.offset,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: catalogInclude,
      }),
    ]);
    return {
      total,
      data: records.map(catalogView),
      limit: query.limit,
      offset: query.offset,
    };
  }

  async get(scopeInput: CommerceScope, id: string) {
    this.features.assertCatalogEnabled();
    const product = await this.prisma.product.findFirst({
      where: { id, ...productWhere(scopeInput) },
      include: catalogInclude,
    });
    if (!product) throw new NotFoundException('Product not found');
    return catalogView(product);
  }

  async create(
    scopeInput: CommerceScope,
    actorAdminId: string,
    input: CreateProductDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const parsed = CreateProductDto.schema.parse(input);
    const requestId = parsed.requestId ?? randomUUID();
    const dto = {
      ...parsed,
      requestId,
    };
    return this.commands.execute(
      scope,
      actorAdminId,
      dto.requestId,
      'CREATE_PRODUCT',
      dto,
      async (tx) => {
        await lockProductPreset(tx, scope, 'shared');
        const definitions = await loadCatalogFields(tx, scope);
        const { requestId: _requestId, variants, ...fields } = dto;
        void _requestId;
        assertProductPricing(variants ?? []);
        const product = await tx.product.create({
          data: {
            ...productWhere(scope),
            ...fields,
          },
        });
        for (const variant of variants ?? [
          {
            sku: `V-${requestId}`,
            meta: {},
            price: null,
            trackStock: true,
            currency: 'THB' as const,
            active: true,
          },
        ]) {
          const record = await tx.productVariant.create({
            data: {
              companyId: scope.companyId,
              productId: product.id,
              ...variant,
              meta: checked(definitions, 'VARIANT', fields.category, {
                values: variantAttributes(variant),
              }),
            },
          });
          if (variant.trackStock)
            await tx.inventoryBalance.create({
              data: { companyId: scope.companyId, variantId: record.id },
            });
        }
        await this.index(tx, scope, product.id);
        return this.view(tx, scope, product.id);
      },
    );
  }

  async update(
    scopeInput: CommerceScope,
    actorAdminId: string,
    id: string,
    input: UpdateProductDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const dto = UpdateProductDto.schema.parse(input);
    return this.commands.execute(
      scope,
      actorAdminId,
      dto.requestId,
      'UPDATE_PRODUCT',
      { id, ...dto },
      async (tx) => {
        await lockProductPreset(tx, scope, 'shared');
        const product = await lockProduct(tx, scope, id);
        if (product.revision !== dto.expectedVersion)
          throw new ConflictException('Product version changed');
        const variants = await tx.productVariant.findMany({
          where: { productId: id, companyId: scope.companyId },
          include: { inventory: true },
        });
        if (
          (dto.status ?? product.status) === 'ACTIVE' &&
          !variants.some((variant) => variant.active)
        ) {
          throw new ConflictException(
            'Active products require an active variant',
          );
        }
        const {
          requestId: _requestId,
          expectedVersion: _version,
          ...fields
        } = dto;
        void _requestId;
        void _version;
        assertProductPricing(variants);
        const category =
          fields.category !== undefined ? fields.category : product.category;
        if (category !== product.category) {
          const definitions = await loadCatalogFields(tx, scope);
          for (const variant of variants)
            checked(definitions, 'VARIANT', category, {
              stored: variantAttributes(variant),
            });
        }
        const searchChanged = [
          'name',
          'aliases',
          'description',
          'category',
          'language',
          'status',
        ].some(
          (field) =>
            fields[field] !== undefined &&
            JSON.stringify(fields[field]) !== JSON.stringify(product[field]),
        );
        await tx.product.update({
          where: { id, ...productWhere(scope), revision: dto.expectedVersion },
          data: {
            ...fields,
            revision: { increment: 1 },
            ...(searchChanged ? { searchRevision: { increment: 1 } } : {}),
          },
        });
        if (searchChanged) await this.index(tx, scope, id);
        return this.view(tx, scope, id);
      },
    );
  }

  async createVariant(
    scopeInput: CommerceScope,
    actorAdminId: string,
    id: string,
    input: CreateProductVariantDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const dto = CreateProductVariantDto.schema.parse(input);
    return this.commands.execute(
      scope,
      actorAdminId,
      dto.requestId,
      'CREATE_VARIANT',
      { id, ...dto },
      async (tx) => {
        await lockProductPreset(tx, scope, 'shared');
        const product = await lockProduct(tx, scope, id);
        if (product.revision !== dto.expectedProductVersion)
          throw new ConflictException('Product version changed');
        const {
          requestId: _requestId,
          expectedProductVersion: _version,
          ...fields
        } = dto;
        void _requestId;
        void _version;
        assertProductPricing([fields]);
        const variant = await tx.productVariant.create({
          data: {
            companyId: scope.companyId,
            productId: id,
            ...fields,
            meta: checked(
              await loadCatalogFields(tx, scope),
              'VARIANT',
              product.category,
              { values: variantAttributes(fields) },
            ),
          },
        });
        if (variant.trackStock)
          await tx.inventoryBalance.create({
            data: { companyId: scope.companyId, variantId: variant.id },
          });
        await tx.product.update({
          where: { id, ...productWhere(scope) },
          data: {
            revision: { increment: 1 },
            searchRevision: { increment: 1 },
          },
        });
        await this.index(tx, scope, id);
        return this.view(tx, scope, id);
      },
    );
  }

  async updateVariant(
    scopeInput: CommerceScope,
    actorAdminId: string,
    id: string,
    variantId: string,
    input: UpdateProductVariantDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const dto = UpdateProductVariantDto.schema.parse(input);
    return this.commands.execute(
      scope,
      actorAdminId,
      dto.requestId,
      'UPDATE_VARIANT',
      { id, variantId, ...dto },
      async (tx) => {
        await lockProductPreset(tx, scope, 'shared');
        const product = await lockProduct(tx, scope, id);
        if (product.revision !== dto.expectedProductVersion)
          throw new ConflictException('Product version changed');
        const variant = await tx.productVariant.findFirst({
          where: { id: variantId, productId: id, companyId: scope.companyId },
          include: { inventory: true },
        });
        if (!variant) throw new NotFoundException('Product variant not found');
        if (variant.version !== dto.expectedVersion)
          throw new ConflictException('Variant version changed');
        if (
          dto.active === false &&
          variant.active &&
          product.status === 'ACTIVE'
        ) {
          const active = await tx.productVariant.count({
            where: { productId: id, companyId: scope.companyId, active: true },
          });
          if (active === 1)
            throw new ConflictException(
              'Cannot disable the last active variant',
            );
        }
        const {
          requestId: _requestId,
          expectedVersion: _version,
          expectedProductVersion: _productVersion,
          ...fields
        } = dto;
        void _requestId;
        void _version;
        void _productVersion;
        if (
          dto.trackStock !== undefined &&
          dto.trackStock !== variant.trackStock
        ) {
          if ((variant.inventory?.reserved ?? 0) > 0)
            throw new ConflictException(
              'Cannot change stock tracking while inventory is reserved',
            );
          if (dto.trackStock && !variant.inventory)
            await tx.inventoryBalance.create({
              data: { companyId: scope.companyId, variantId },
            });
        }
        assertProductPricing([{ ...variant, ...fields }]);
        if (fields.meta !== undefined)
          fields.meta = mergedMeta(
            await loadCatalogFields(tx, scope),
            product.category,
            variantAttributes(variant),
            fields.meta,
          ) as typeof fields.meta;
        const searchChanged = ['sku', 'meta', 'active'].some(
          (field) =>
            fields[field] !== undefined &&
            JSON.stringify(fields[field]) !== JSON.stringify(variant[field]),
        );
        await tx.productVariant.update({
          where: {
            id: variantId,
            companyId: scope.companyId,
            productId: id,
            version: dto.expectedVersion,
          },
          data: { ...fields, version: { increment: 1 } },
        });
        await tx.product.update({
          where: { id, ...productWhere(scope) },
          data: {
            revision: { increment: 1 },
            ...(searchChanged ? { searchRevision: { increment: 1 } } : {}),
          },
        });
        if (searchChanged) await this.index(tx, scope, id);
        return this.view(tx, scope, id);
      },
    );
  }

  private async view(
    tx: Prisma.TransactionClient,
    scope: CommerceScope,
    id: string,
  ) {
    return catalogView(
      await tx.product.findFirstOrThrow({
        where: { id, ...productWhere(scope) },
        include: catalogInclude,
      }),
    );
  }

  private async index(
    tx: Prisma.TransactionClient,
    scope: CommerceScope,
    id: string,
  ) {
    if (!this.features.productSemanticEnabled) return;
    await enqueueProductIndex(
      tx,
      id,
      scope.companyId,
      this.config?.get<string>('GEMINI_EMBEDDING_MODEL') ||
        'gemini-embedding-2',
    );
  }
}

function catalogView(product: CatalogRecord) {
  return {
    ...product,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    variants: product.variants.map((variant) => ({
      ...variant,
      price: variant.price?.toFixed(2) ?? null,
      meta: variantAttributes(variant),
      compareAtPrice: variant.compareAtPrice?.toFixed(2) ?? null,
      ...productDiscount(variant),
      effectivePrice: variant.price?.toFixed(2) ?? null,
      createdAt: variant.createdAt.toISOString(),
      updatedAt: variant.updatedAt.toISOString(),
      inventory:
        variant.trackStock && variant.inventory
          ? {
              ...variant.inventory,
              available: variant.inventory.onHand - variant.inventory.reserved,
              updatedAt: variant.inventory.updatedAt.toISOString(),
            }
          : null,
    })),
  };
}

/**
 * PATCH meta: the sent fields replace their stored values, null clears a
 * field, and every other stored field is kept. The merged result is
 * validated as a whole, so required fields are still enforced.
 */
function mergedMeta(
  definitions: readonly AttributeDefinition[],
  category: string | null,
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): Prisma.InputJsonObject {
  const kept = { ...stored };
  for (const [key, value] of Object.entries(patch))
    if (value === null) delete kept[key];
  const active = new Set(
    definitions
      .filter((d) => d.scope === 'VARIANT' && d.status === 'ACTIVE')
      .map((d) => d.key),
  );
  return checked(definitions, 'VARIANT', category, {
    values: {
      ...Object.fromEntries(
        Object.entries(kept).filter(([key]) => active.has(key)),
      ),
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== null),
      ),
    },
    stored: kept,
  });
}

/**
 * Validated field values to store. Without new values, the stored active ones
 * are re-checked (e.g. after a category change) and kept as they are.
 */
function checked(
  definitions: readonly AttributeDefinition[],
  scope: AttributeScope,
  category: string | null | undefined,
  input: { values?: Record<string, unknown>; stored?: unknown },
): Prisma.InputJsonObject {
  const stored =
    input.stored && typeof input.stored === 'object'
      ? (input.stored as Record<string, unknown>)
      : {};
  const archived = new Set(
    definitions
      .filter((d) => d.scope === scope && d.status === 'ARCHIVED')
      .map((d) => d.key),
  );
  const values =
    input.values ??
    Object.fromEntries(
      Object.entries(stored).filter(
        ([key]) =>
          !archived.has(key) &&
          definitions.some((d) => d.scope === scope && d.key === key),
      ),
    );
  return validateAttributeValues({
    definitions,
    scope,
    category,
    values,
    stored,
    enforceRequired: input.values !== undefined,
  }) as Prisma.InputJsonObject;
}
