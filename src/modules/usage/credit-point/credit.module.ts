import { Module } from '@nestjs/common';
import { CompanyModule } from '../../admin/company/company.module';
import { CreditServiceController } from './credit.controller';
import { CreditService } from './credit.service';

@Module({
  imports: [CompanyModule],
  controllers: [CreditServiceController],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditServiceModule {}
