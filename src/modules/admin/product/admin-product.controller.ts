import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import type { AdminRole } from '../../../shared/guards/admin-auth.types';
import { ADMIN_ROLES_KEY } from '../../../shared/guards/admin-roles.guard';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';
import { CommerceFeatureService } from '../../commerce/commerce-feature.service';
import {
  AdjustProductStockDto,
  BulkCreateProductDto,
  CreateProductDto,
  DeleteProductDto,
  CreateProductVariantDto,
  ListProductsQueryDto,
  ProductIdParamDto,
  ProductVariantParamDto,
  UpdateProductDto,
  UpdateProductVariantDto,
} from '../../products/dto/product.dto';
import { AdminProductService } from './admin-product.service';
import { InventoryService } from '../../products/inventory.service';
import { z } from 'zod';

@AdminGuard('owner', 'admin', 'dev')
@Controller('api/admin/products')
export class AdminProductController {
  constructor(
    private readonly products: AdminProductService,
    private readonly inventory: InventoryService,
    private readonly scopes: CommerceScopeService,
    private readonly features: CommerceFeatureService,
  ) {}

  @Get()
  async list(
    @Req() request: AdminRequest,
    @Query() query: ListProductsQueryDto,
  ) {
    return this.products.list(await this.scope(request), query);
  }

  @Get(':id')
  async get(@Req() request: AdminRequest, @Param() params: ProductIdParamDto) {
    return this.products.get(await this.scope(request), params.id);
  }

  @Post()
  async create(@Req() request: AdminRequest, @Body() body: CreateProductDto) {
    const key = request.headers['idempotency-key'];
    if (key !== undefined) {
      const parsed = z.string().uuid().safeParse(key);
      if (!parsed.success)
        throw new BadRequestException('Idempotency-Key must be a UUID');
      if (body.requestId && body.requestId !== parsed.data)
        throw new BadRequestException(
          'Idempotency-Key and requestId must match',
        );
      body = { ...body, requestId: parsed.data };
    }
    return this.products.create(
      await this.scope(request),
      request.admin!.id,
      body,
    );
  }

  // Overrides the class roles; the class guards still authenticate the JWT.
  @SetMetadata(ADMIN_ROLES_KEY, ['dev'] satisfies AdminRole[])
  @Post('bulk')
  async createMany(
    @Req() request: AdminRequest,
    @Body() body: BulkCreateProductDto,
  ) {
    // One key cannot cover many commands; each item carries its own requestId.
    if (request.headers['idempotency-key'] !== undefined)
      throw new BadRequestException(
        'Bulk create uses requestId on each item, not Idempotency-Key',
      );
    return this.products.createMany(
      await this.scope(request),
      request.admin!.id,
      body,
    );
  }

  @Patch(':id')
  async update(
    @Req() request: AdminRequest,
    @Param() params: ProductIdParamDto,
    @Body() body: UpdateProductDto,
  ) {
    return this.products.update(
      await this.scope(request),
      request.admin!.id,
      params.id,
      body,
    );
  }

  @Delete(':id')
  async remove(
    @Req() request: AdminRequest,
    @Param() params: ProductIdParamDto,
    @Body() body: DeleteProductDto,
  ) {
    return this.products.remove(
      await this.scope(request),
      request.admin!.id,
      params.id,
      body,
    );
  }

  @Post(':id/variants')
  async createVariant(
    @Req() request: AdminRequest,
    @Param() params: ProductIdParamDto,
    @Body() body: CreateProductVariantDto,
  ) {
    return this.products.createVariant(
      await this.scope(request),
      request.admin!.id,
      params.id,
      body,
    );
  }

  @Patch(':id/variants/:variantId')
  async updateVariant(
    @Req() request: AdminRequest,
    @Param() params: ProductVariantParamDto,
    @Body() body: UpdateProductVariantDto,
  ) {
    return this.products.updateVariant(
      await this.scope(request),
      request.admin!.id,
      params.id,
      params.variantId,
      body,
    );
  }

  @Post(':id/variants/:variantId/stock-adjustments')
  async adjustStock(
    @Req() request: AdminRequest,
    @Param() params: ProductVariantParamDto,
    @Body() body: AdjustProductStockDto,
  ) {
    return this.inventory.adjust(
      await this.scope(request),
      request.admin!.id,
      params.id,
      params.variantId,
      body,
    );
  }

  private async scope(request: AdminRequest) {
    if (!request.admin)
      throw new UnauthorizedException('Admin authentication required');
    this.features.assertCatalogEnabled();
    return this.scopes.forAdmin(request.admin);
  }
}
