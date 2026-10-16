import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../../admin/admin-jwt-auth.guard';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';
import { CommerceFeatureService } from '../../commerce/commerce-feature.service';
import {
  ApplyBusinessPresetDto,
  BusinessPresetParamDto,
  ListProductAttributesQueryDto,
} from '../dto/product-attribute.dto';
import { ProductAttributeService } from './product-attribute.service';
import { z } from 'zod';

/** Code-defined business presets and selected product form fields. */
@AdminGuard('owner', 'admin', 'dev')
@Controller('api/admin/products/attributes')
export class ProductAttributeController {
  constructor(
    private readonly attributes: ProductAttributeService,
    private readonly scopes: CommerceScopeService,
    private readonly features: CommerceFeatureService,
  ) {}

  @Get()
  async list(
    @Req() request: AdminRequest,
    @Query() query: ListProductAttributesQueryDto,
  ) {
    return this.attributes.list(await this.scope(request), query);
  }

  @Get('presets')
  async presets(@Req() request: AdminRequest) {
    return this.attributes.presets(await this.scope(request));
  }

  @Post('presets/:type/apply')
  async applyPreset(
    @Req() request: AdminRequest,
    @Param() params: BusinessPresetParamDto,
    @Body() body: ApplyBusinessPresetDto,
  ) {
    return this.attributes.applyPreset(
      await this.scope(request),
      request.admin!.id,
      params.type,
      this.withRequestId(request, body),
    );
  }

  private withRequestId<T extends { requestId?: string }>(
    request: AdminRequest,
    body: T,
  ): T {
    const key = request.headers['idempotency-key'];
    if (key === undefined) return body;
    const parsed = z.string().uuid().safeParse(key);
    if (!parsed.success)
      throw new BadRequestException('Idempotency-Key must be a UUID');
    if (body.requestId && body.requestId !== parsed.data)
      throw new BadRequestException('Idempotency-Key and requestId must match');
    return { ...body, requestId: parsed.data };
  }

  private async scope(request: AdminRequest) {
    if (!request.admin)
      throw new UnauthorizedException('Admin authentication required');
    this.features.assertCatalogEnabled();
    return this.scopes.forAdmin(request.admin);
  }
}
