import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../../admin/admin-jwt-auth.guard';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';
import { CommerceFeatureService } from '../../commerce/commerce-feature.service';
import { ProductIdParamDto } from '../dto/product.dto';
import { ProductCommandService } from '../product-command.service';
import { ProductIndexService } from './product-index.service';

class ReindexProductDto extends createZodDto(
  z
    .object({
      requestId: z.string().uuid(),
      expectedVersion: z.number().int().min(1).max(2147483646),
    })
    .strict(),
) {}

@AdminGuard('owner', 'admin', 'dev')
@Controller('api/admin/products')
export class ProductIndexController {
  constructor(
    private readonly index: ProductIndexService,
    private readonly scopes: CommerceScopeService,
    private readonly features: CommerceFeatureService,
    private readonly commands: ProductCommandService,
  ) {}
  @Get('index/status')
  async status(@Req() request: AdminRequest) {
    return this.index.status(await this.scope(request));
  }
  @Post(':id/reindex')
  async reindex(
    @Req() request: AdminRequest,
    @Param() params: ProductIdParamDto,
    @Body() body: ReindexProductDto,
  ) {
    return this.index.reindex(
      await this.scope(request),
      request.admin!.id,
      params.id,
      body.requestId,
      body.expectedVersion,
      this.commands,
    );
  }
  private scope(request: AdminRequest) {
    if (!request.admin)
      throw new UnauthorizedException('Admin authentication required');
    this.features.assertCatalogEnabled();
    return this.scopes.forAdmin(request.admin);
  }
}
