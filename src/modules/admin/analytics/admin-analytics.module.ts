import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { CompanyModule } from '../company/company.module';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsRepository } from './admin-analytics.repository';
import { AdminAnalyticsService } from './admin-analytics.service';

@Module({
  imports: [PrismaModule, CompanyModule],
  controllers: [AdminAnalyticsController],
  providers: [AdminAnalyticsService, AdminAnalyticsRepository],
})
export class AdminAnalyticsModule {}
