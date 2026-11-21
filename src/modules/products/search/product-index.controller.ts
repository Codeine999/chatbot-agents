import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import type { AdminRole } from '../../../shared/guards/admin-auth.types';
import { ADMIN_ROLES_KEY } from '../../../shared/guards/admin-roles.guard';
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

class ReindexAllProductsDto extends createZodDto(
  z
    .object({
      requestId: z.string().uuid(),
      /** Also re-embed products whose index is already up to date (costs credit). */
      force: z.boolean().default(false),
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
  // Bills one embedding per queued product, so it is owner/dev only.
  @SetMetadata(ADMIN_ROLES_KEY, ['owner', 'dev'] satisfies AdminRole[])
  @Post('index/reindex')
  async reindexAll(
    @Req() request: AdminRequest,
    @Body() body: ReindexAllProductsDto,
  ) {
    return this.index.reindexAll(
      await this.scope(request),
      request.admin!.id,
      body.requestId,
      body.force,
      this.commands,
    );
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
