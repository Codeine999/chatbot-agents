import { Controller, Get } from '@nestjs/common';
import { AdminGuard } from '../../shared/guards/admin-guard.decorator';
import { CompanyService } from '../company/company.service';
import { LineService } from './line-reply.service';

@AdminGuard()
@Controller('api/line/dashboard')
export class LineDashboardController {
  constructor(
    private readonly lineService: LineService,
    private readonly companyService: CompanyService,
  ) {}

  @Get('info')
  getInfo() {
    return this.lineService.getBotInfo();
  }

  @Get('followers')
  async getFollowers() {
    const now = new Date();
    const insight = await this.lineService.getFollowerInsight(
      this.formatDate(now),
    );

    if (insight.status !== 'ready' || insight.followers === undefined) {
      return {
        status: insight.status,
        followers: null,
        targetedReaches: null,
        blocks: null,
        changePercent: null,
        sinceDate: null,
      };
    }

    await this.companyService.recordFollowerSnapshot(now, {
      followerCount: insight.followers,
      targetedReaches: insight.targetedReaches,
      blockCount: insight.blocks,
    });

    const change = await this.companyService.getFollowerChange(
      insight.followers,
      now,
    );

    return {
      status: insight.status,
      followers: insight.followers,
      targetedReaches: insight.targetedReaches ?? null,
      blocks: insight.blocks ?? null,
      changePercent: change.changePercent,
      sinceDate: change.sinceDate,
    };
  }

  @Get('message-usage')
  async getMessageUsage() {
    const [sentThisMonth, quota] = await Promise.all([
      this.companyService.getMonthlyMessageCount(),
      this.lineService.getMessageQuotaConsumption(),
    ]);

    return {
      sentThisMonth,
      quotaUsed: quota.totalUsage,
    };
  }

  private formatDate(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }
}
