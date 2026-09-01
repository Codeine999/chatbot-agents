import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { LineModule } from '../../line/line.module';
import { CompanyModule } from '../company/company.module';
import { AdminUsageController } from './admin-usage.controller';
import { AdminUsageService } from './admin-usage.service';

@Module({
  imports: [PrismaModule, CompanyModule, LineModule],
  controllers: [AdminUsageController],
  providers: [AdminUsageService],
})
export class AdminUsageModule {}
