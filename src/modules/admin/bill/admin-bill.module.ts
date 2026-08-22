import { Module } from '@nestjs/common';
import { CompanyModule } from '../company/company.module';
import { AdminBillController } from './admin-bill.controller';
import { AdminBillService } from './admin-bill.service';

@Module({
  imports: [CompanyModule],
  controllers: [AdminBillController],
  providers: [AdminBillService],
})
export class AdminBillModule {}
