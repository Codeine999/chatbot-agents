import {
  Controller,
  Body,
  Get,
  HttpCode,
  ParseUUIDPipe,
  Post,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { MultipartUploadService } from '../../../shared/upload/multipart-upload.service';
import { AdminBillService } from './admin-bill.service';
import { BILL_SLIP_MAX_BYTES } from './admin-bill.constants';
import { CreateTopupDto } from './dto/top-up.dto';
import { CalculateCreditDto } from './dto/calculate-credit.dto';
import { GetBillHistoryQueryDto } from './dto/get-history.dto';

@AdminGuard()
@Controller('api/admin/bill')
export class AdminBillController {
  constructor(
    private readonly adminBillService: AdminBillService,
    private readonly multipartUploadService: MultipartUploadService,
  ) {}

  @Get('exchange-rate')
  getExchangeRate() {
    return this.adminBillService.getExchangeRate();
  }

  @Get('packages')
  getPackages() {
    return this.adminBillService.getPackages();
  }

  @Post('calculate-credit')
  @HttpCode(200)
  calculateCredit(@Body() body: CalculateCreditDto) {
    return this.adminBillService.calculateCredit(body);
  }

  @Post('top-up')
  async createTopup(@Req() request: AdminRequest) {
    const dto = await this.multipartUploadService.parseDto(
      request,
      CreateTopupDto.schema,
      {
        maxFileSize: BILL_SLIP_MAX_BYTES,
        maxFiles: 1,
        maxFields: 3,
        notMultipartMessage: 'Package or paid amount and slip are required',
        invalidMultipartMessage: 'Invalid multipart top-up data',
      },
    );

    return this.adminBillService.createTopup(request.admin!.id, dto);
  }

  // @AdminGuard('dev')
  @Post('topup/:id/confirm')
  @HttpCode(200)
  confirmTopup(
    @Param('id', ParseUUIDPipe) topupId: string,
    @Req() request: AdminRequest,
  ) {
    return this.adminBillService.confirmTopup(topupId, request.admin!.id);
  }

  // @AdminGuard('dev')
  @Post('topup/:id/reject')
  @HttpCode(200)
  rejectTopup(
    @Param('id', ParseUUIDPipe) topupId: string,
    @Req() request: AdminRequest,
  ) {
    return this.adminBillService.rejectTopup(topupId, request.admin!.id);
  }

  @Get('history')
  getHistory(@Query() query: GetBillHistoryQueryDto) {
    return this.adminBillService.getHistory(query);
  }
}
