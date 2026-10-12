import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  productWhere,
  type CommerceScope,
} from '../commerce/types/commerce-scope';

/** All catalog/inventory writers lock the parent before touching variants or balances. */
export async function lockProduct(
  tx: Prisma.TransactionClient,
  scope: CommerceScope,
  id: string,
) {
  productWhere(scope);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM products
    WHERE id = ${id}::uuid AND "companyId" = ${scope.companyId}::uuid
    FOR UPDATE`;
  if (!rows.length) throw new NotFoundException('Product not found');
  return tx.product.findFirstOrThrow({
    where: { id, ...productWhere(scope) },
    include: { company: { select: { productBusinessType: true } } },
  });
}
