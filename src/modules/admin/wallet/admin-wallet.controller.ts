import { Controller, Get } from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminWalletService } from './admin-wallet.service';

@AdminGuard()
@Controller('api/admin/wallet')
export class AdminWalletController {
  constructor(private readonly adminWalletService: AdminWalletService) {}

  @Get('mine')
  getMine() {
    return this.adminWalletService.getMine();
  }
}
