import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommerceFeatureService } from '../../commerce/commerce-feature.service';
import {
  productCompanyScope,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import { ProductCommandService } from '../product-command.service';
import {
  ApplyBusinessPresetDto,
  ListProductAttributesQueryDto,
} from '../dto/product-attribute.dto';
import { appliesToCategory } from './utils/attribute-value.util';
import {
  businessPresets,
  catalogFields,
  isBusinessType,
  loadCatalogFields,
} from '../search/catalog-fields';

/** Keep the lock key compatible with preceding releases. */
export async function lockProductPreset(
  tx: Prisma.TransactionClient,
  scope: CommerceScope,
  mode: 'shared' | 'exclusive',
) {
  const key = `attributes:${scope.companyId}`;
  if (mode === 'shared')
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
  else
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
/** Every business field is written to the variant's `meta` under its key. */
function withStorage(field: ReturnType<typeof catalogFields>[number]) {
  return { ...field, storage: { object: 'meta', field: field.key } };
}
@Injectable()
export class ProductAttributeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: ProductCommandService,
    private readonly features: CommerceFeatureService,
  ) {}
  async list(scopeInput: CommerceScope, input: ListProductAttributesQueryDto) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const query = ListProductAttributesQueryDto.schema.parse(input);
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: scope.companyId },
      select: { productBusinessType: true },
    });
    const fields = await loadCatalogFields(this.prisma, scope);
    return {
      selectedType: company.productBusinessType,
      data: fields
        .filter(
          (field) =>
            field.status === (query.status ?? 'ACTIVE') &&
            (!query.scope || field.scope === query.scope) &&
            (!query.category || appliesToCategory(field, query.category)),
        )
        .map(withStorage),
    };
  }
  async presets(scopeInput: CommerceScope) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: scope.companyId },
      select: { productBusinessType: true },
    });
    return {
      selectedType: company.productBusinessType,
      data: businessPresets().map(({ type, label }) => ({
        type,
        label,
        fields: catalogFields(type).map(withStorage),
      })),
    };
  }
  async applyPreset(
    scopeInput: CommerceScope,
    actorAdminId: string,
    type: string,
    input: ApplyBusinessPresetDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = productCompanyScope(scopeInput);
    const parsed = ApplyBusinessPresetDto.schema.parse(input);
    const dto = { ...parsed, requestId: parsed.requestId ?? randomUUID() };
    if (!isBusinessType(type))
      throw new NotFoundException('Unknown business type');
    return this.commands.execute(
      scope,
      actorAdminId,
      dto.requestId,
      'APPLY_ATTRIBUTE_PRESET',
      { type, ...dto },
      async (tx) => {
        await lockProductPreset(tx, scope, 'exclusive');
        const previous = await tx.company.findUniqueOrThrow({
          where: { id: scope.companyId },
          select: { productBusinessType: true, productPresetCategories: true },
        });
        await tx.company.update({
          where: { id: scope.companyId },
          data: {
            productBusinessType: type,
            productPresetCategories: dto.categories,
          },
        });
        if (
          previous.productBusinessType !== type ||
          JSON.stringify(previous.productPresetCategories) !==
            JSON.stringify(dto.categories)
        ) {
          await tx.product.updateMany({
            where: { companyId: scope.companyId },
            data: { searchRevision: { increment: 1 } },
          });
        }
        return {
          type,
          selectedType: type,
          categories: dto.categories,
          fields: catalogFields(type, dto.categories).map(withStorage),
        };
      },
    );
  }
}
