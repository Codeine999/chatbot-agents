import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { CreditServiceModule } from '../../usage/credit-point/credit.module';

@Module({
  imports: [AuthModule, CreditServiceModule],
  controllers: [AdminAuthController],
  providers: [AdminAuthService],
  exports: [AdminAuthService],
})
export class AdminAuthModule {}
