import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminAiPricingService } from './admin-ai-pricing.service';
import { AiPricingCatalogService } from './ai-pricing-catalog.service';
import {
  AiModelPricingIdParamDto,
  ListAiModelPricingQueryDto,
  SeedAiModelPricingDto,
  UpsertAiModelPricingDto,
} from './dto/admin-ai-pricing.dto';

@AdminGuard('dev', 'owner')
@Controller('api/admin/ai-pricing')
export class AdminAiPricingController {
  constructor(
    private readonly pricingService: AdminAiPricingService,
    private readonly catalogService: AiPricingCatalogService,
  ) {}

  @Get()
  list(@Query() query: ListAiModelPricingQueryDto) {
    return this.pricingService.list(query);
  }

  /** Configured models that currently bill at zero credit. */
  @Get('unpriced')
  unpriced() {
    return this.pricingService.unpriced();
  }

  @Post()
  upsert(@Body() body: UpsertAiModelPricingDto) {
    return this.pricingService.upsert(body);
  }

  /**
   * Publishes the built-in provider list prices, converted to credit rates.
   * Without this a fresh install has no prices and every AI call is refused.
   */
  @Post('defaults')
  seedDefaults(@Body() body: SeedAiModelPricingDto) {
    return this.catalogService.seedDefaults({ overwrite: body.overwrite });
  }

  @Delete(':id')
  remove(@Param() params: AiModelPricingIdParamDto) {
    return this.pricingService.remove(params.id);
  }
}
