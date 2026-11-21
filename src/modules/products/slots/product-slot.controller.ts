import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../../admin/admin-jwt-auth.guard';
import { CommerceFeatureService } from '../../commerce/commerce-feature.service';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';
import {
  BulkSlotsDto,
  GenerateSlotsDto,
  ListSlotsQueryDto,
  PatchSlotDto,
  ProductSlotIdParamDto,
  ProductSlotParamDto,
} from './product-slot.dto';
import { ProductSlotService } from './product-slot.service';

/** Dated occurrences (departures, intakes) of one variant. Same guard and scope as the catalog. */
@AdminGuard('owner', 'admin', 'dev')
@Controller('api/admin/products/:id/variants/:variantId/slots')
export class ProductSlotController {
  constructor(
    private readonly slots: ProductSlotService,
    private readonly scopes: CommerceScopeService,
    private readonly features: CommerceFeatureService,
  ) {}

  @Get()
  async list(
    @Req() request: AdminRequest,
    @Param() params: ProductSlotParamDto,
    @Query() query: ListSlotsQueryDto,
  ) {
    return this.slots.list(await this.scope(request), params.variantId, query);
  }

  @Post('generate')
  async generate(
    @Req() request: AdminRequest,
    @Param() params: ProductSlotParamDto,
    @Body() body: GenerateSlotsDto,
  ) {
    return this.slots.generate(
      await this.scope(request),
      request.admin!.id,
      params.id,
      params.variantId,
      this.withRequestId(request, body),
    );
  }

  @Post('bulk')
  async bulk(
    @Req() request: AdminRequest,
    @Param() params: ProductSlotParamDto,
    @Body() body: BulkSlotsDto,
  ) {
    return this.slots.bulkUpsert(
      await this.scope(request),
      request.admin!.id,
      params.id,
      params.variantId,
      this.withRequestId(request, body),
    );
  }

  @Patch(':slotId')
  async patch(
    @Req() request: AdminRequest,
    @Param() params: ProductSlotIdParamDto,
    @Body() body: PatchSlotDto,
  ) {
    return this.slots.patch(
      await this.scope(request),
      request.admin!.id,
      params.id,
      params.variantId,
      params.slotId,
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
