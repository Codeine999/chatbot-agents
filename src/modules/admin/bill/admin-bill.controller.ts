import {
  Controller,
  Get,
  HttpCode,
  ParseUUIDPipe,
  Post,
  Param,
  Req,
} from '@nestjs/common';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminBillService } from './admin-bill.service';

@AdminGuard()
@Controller('api/admin/bill')
export class AdminBillController {
  constructor(private readonly adminBillService: AdminBillService) {}

  @Post('topup')
  createTopup(@Req() request: AdminRequest) {
    return this.adminBillService.createTopup(request.admin!.id, request);
  }

  @AdminGuard('dev')
  @Post('topup/:id/confirm')
  @HttpCode(200)
  confirmTopup(
    @Param('id', ParseUUIDPipe) topupId: string,
    @Req() request: AdminRequest,
  ) {
    return this.adminBillService.confirmTopup(topupId, request.admin!.id);
  }

  @AdminGuard('dev')
  @Post('topup/:id/reject')
  @HttpCode(200)
  rejectTopup(
    @Param('id', ParseUUIDPipe) topupId: string,
    @Req() request: AdminRequest,
  ) {
    return this.adminBillService.rejectTopup(topupId, request.admin!.id);
  }

  @Get('history')
  getHistory() {
    return this.adminBillService.getHistory();
  }
}
