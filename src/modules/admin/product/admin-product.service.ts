import { Injectable } from '@nestjs/common';
import type { CommerceScope } from '../../commerce/types/commerce-scope';
import {
  CreateProductDto,
  CreateProductVariantDto,
  DeleteProductDto,
  ListProductsQueryDto,
  UpdateProductDto,
  UpdateProductVariantDto,
} from '../../products/dto/product.dto';
import { ProductService } from '../../products/product.service';

/** Admin API operations reuse the catalog's ownership, transaction and replay rules. */
@Injectable()
export class AdminProductService {
  constructor(private readonly products: ProductService) {}

  list(scope: CommerceScope, query: ListProductsQueryDto) {
    return this.products.list(scope, query);
  }

  get(scope: CommerceScope, id: string) {
    return this.products.get(scope, id);
  }

  create(scope: CommerceScope, actorId: string, input: CreateProductDto) {
    return this.products.create(scope, actorId, input);
  }

  update(
    scope: CommerceScope,
    actorId: string,
    id: string,
    input: UpdateProductDto,
  ) {
    return this.products.update(scope, actorId, id, input);
  }

  remove(
    scope: CommerceScope,
    actorId: string,
    id: string,
    input: DeleteProductDto,
  ) {
    const command = DeleteProductDto.schema.parse(input);
    // Archive preserves inventory movements, command history and vector ownership.
    return this.products.update(scope, actorId, id, {
      ...command,
      status: 'ARCHIVED',
    });
  }

  createVariant(
    scope: CommerceScope,
    actorId: string,
    id: string,
    input: CreateProductVariantDto,
  ) {
    return this.products.createVariant(scope, actorId, id, input);
  }

  updateVariant(
    scope: CommerceScope,
    actorId: string,
    id: string,
    variantId: string,
    input: UpdateProductVariantDto,
  ) {
    return this.products.updateVariant(scope, actorId, id, variantId, input);
  }
}
