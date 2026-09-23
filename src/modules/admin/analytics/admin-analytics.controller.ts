import { Controller, Get, Query } from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminAnalyticsService } from './admin-analytics.service';
import { GetAdminAnalyticsQueryDto } from './dto/get-admin-analytics-query.dto';

@AdminGuard()
@Controller('api/admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly analyticsService: AdminAnalyticsService) {}

  /** LINE message volume per sender. */
  @Get('chat')
  getChatActivity(@Query() query: GetAdminAnalyticsQueryDto) {
    return this.analyticsService.getChatActivity(query);
  }

  /** Credit and token spend already recorded by the billing pipeline. */
  @Get('credit-usage')
  getCreditUsage(@Query() query: GetAdminAnalyticsQueryDto) {
    return this.analyticsService.getCreditUsage(query);
  }

  /** LINE follower level per bucket, from the daily snapshot. */
  @Get('followers')
  getFollowers(@Query() query: GetAdminAnalyticsQueryDto) {
    return this.analyticsService.getFollowers(query);
  }

  /** Successful customer payments. */
  @Get('revenue')
  getRevenue(@Query() query: GetAdminAnalyticsQueryDto) {
    return this.analyticsService.getRevenue(query);
  }
}
