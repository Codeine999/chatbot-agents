import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { CompanyModule } from '../company/company.module';
import { AdminWalletController } from './admin-wallet.controller';
import { AdminWalletService } from './admin-wallet.service';

@Module({
  imports: [PrismaModule, CompanyModule],
  controllers: [AdminWalletController],
  providers: [AdminWalletService],
})
export class AdminWalletModule {}
