import { Body, Controller, Patch, Post } from '@nestjs/common';
import { AdminGuard } from '../../../../shared/guards/admin-guard.decorator';
import { CreditExchangeRateService } from './credit-exchange-rate.service';
import { CreditExchangeRateDto } from './dto/credit-exchange-rate.dto';
import { CreatePackagePriceDto } from './dto/create-package-price.dto';

@AdminGuard('dev')
@Controller('api/dev')
export class CreditExchangeRateController {
  constructor(
    private readonly creditExchangeRateService: CreditExchangeRateService,
  ) {}

  @Post('credit-create')
  create(@Body() body: CreditExchangeRateDto) {
    return this.creditExchangeRateService.create(body);
  }

  @Patch('credit-update')
  update(@Body() body: CreditExchangeRateDto) {
    return this.creditExchangeRateService.update(body);
  }

  @Post('package/create')
  createPackage(@Body() body: CreatePackagePriceDto) {
    return this.creditExchangeRateService.createPackage(body);
  }
}
