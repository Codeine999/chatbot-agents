import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommerceFeatureService } from '../commerce/commerce-feature.service';
import { scoped, type CommerceScope } from '../commerce/types/commerce-scope';
import { AdjustProductStockDto } from './dto/product.dto';
import { ProductCommandService } from './product-command.service';
import { lockProduct } from './product-lock';

@Injectable()
export class InventoryService {
  constructor(
    private readonly commands: ProductCommandService,
    private readonly features: CommerceFeatureService,
  ) {}

  async adjust(
    scopeInput: CommerceScope,
    actorAdminId: string,
    productId: string,
    variantId: string,
    input: AdjustProductStockDto,
  ) {
    this.features.assertCatalogEnabled();
    const scope = scoped(scopeInput);
    const dto = AdjustProductStockDto.schema.parse(input);
    return this.commands.execute(
      scope,
      actorAdminId,
      dto.requestId,
      'ADJUST_STOCK',
      { productId, variantId, ...dto },
      async (tx, commandId) => {
        await lockProduct(tx, scope, productId);
        const variant = await tx.productVariant.findFirst({
          where: { id: variantId, companyId: scope.companyId, productId },
        });
        if (!variant) throw new NotFoundException('Product variant not found');
        if (!variant.trackStock)
          throw new ConflictException('Variant does not track stock');
        const balances = await tx.$queryRaw<
          { id: string; onHand: number; reserved: number; version: number }[]
        >`
        SELECT id, "onHand", reserved, version FROM "inventoryBalances"
        WHERE "variantId" = ${variantId}::uuid AND "companyId" = ${scope.companyId}::uuid FOR UPDATE`;
        const balance = balances[0];
        if (!balance)
          throw new NotFoundException('Inventory balance not found');
        if (balance.version !== dto.expectedVersion)
          throw new ConflictException('Inventory version changed');
        const onHand = balance.onHand + dto.deltaOnHand;
        if (onHand < balance.reserved || onHand > 2147483647)
          throw new ConflictException(
            'Stock adjustment would violate available inventory',
          );
        const updated = await tx.inventoryBalance.update({
          where: {
            id: balance.id,
            companyId: scope.companyId,
            version: dto.expectedVersion,
          },
          data: { onHand, version: { increment: 1 } },
        });
        const movement = await tx.inventoryMovement.create({
          data: {
            companyId: scope.companyId,
            variantId,
            commandId,
            actorAdminId,
            deltaOnHand: dto.deltaOnHand,
            deltaReserved: 0,
            onHandAfter: updated.onHand,
            reservedAfter: updated.reserved,
            reason: dto.reason,
            operationKey: `product-stock:${scope.companyId}:${dto.requestId}`,
          },
        });
        return {
          ...updated,
          available: updated.onHand - updated.reserved,
          updatedAt: updated.updatedAt.toISOString(),
          movementId: movement.id,
        };
      },
    );
  }
}
