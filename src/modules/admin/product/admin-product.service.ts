import { HttpException, Injectable, Logger } from '@nestjs/common';
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

type CreatedProduct = Awaited<ReturnType<ProductService['create']>>;

export type BulkCreateProductResult = {
  created: CreatedProduct[];
  failed: Array<{ index: number; name: string; reason: string }>;
};

/** Admin API operations reuse the catalog's ownership, transaction and replay rules. */
@Injectable()
export class AdminProductService {
  private readonly logger = new Logger(AdminProductService.name);

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

  /**
   * Sequential on purpose: each item is its own idempotent catalog command, so
   * a failed item neither rolls back nor blocks the items that succeeded.
   */
  async createMany(
    scope: CommerceScope,
    actorId: string,
    items: CreateProductDto[],
  ): Promise<BulkCreateProductResult> {
    const result: BulkCreateProductResult = { created: [], failed: [] };
    for (const [index, item] of items.entries()) {
      try {
        result.created.push(await this.products.create(scope, actorId, item));
      } catch (error) {
        // Only HTTP exceptions carry client-safe messages.
        if (!(error instanceof HttpException))
          this.logger.error(
            `Bulk product create failed at index ${index}`,
            error,
          );
        result.failed.push({
          index,
          name: item.name,
          reason:
            error instanceof HttpException ? error.message : 'Create failed',
        });
      }
    }
    return result;
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
