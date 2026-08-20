import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Company } from '../../../generated/prisma/client';

export type FollowerChange = {
  changePercent: number | null;
  sinceDate: string | null;
};

/**
 * `Company` is a singleton — this app serves exactly one LINE OA/company,
 * so every read/write here operates on the single existing row (creating
 * it lazily on first use).
 */
@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  async recordOutboundMessage(count = 1): Promise<void> {
    const period = this.currentPeriod();
    const company = await this.getOrCreate();

    if (company.messagesSentPeriod === period) {
      await this.prisma.company.update({
        where: { id: company.id },
        data: { messagesSentCount: { increment: count } },
      });
      return;
    }

    // Period rolled over (e.g. new month) — start the counter fresh.
    await this.prisma.company.update({
      where: { id: company.id },
      data: { messagesSentPeriod: period, messagesSentCount: count },
    });
  }

  async getMonthlyMessageCount(): Promise<{ period: string; count: number }> {
    const company = await this.getOrCreate();
    const period = this.currentPeriod();

    return {
      period,
      count:
        company.messagesSentPeriod === period ? company.messagesSentCount : 0,
    };
  }

  async recordFollowerSnapshot(
    date: Date,
    data: {
      followerCount: number;
      targetedReaches?: number;
      blockCount?: number;
    },
  ): Promise<void> {
    const day = this.startOfDay(date);

    await this.prisma.lineFollowerSnapshot.upsert({
      where: { date: day },
      create: { date: day, ...data },
      update: { ...data },
    });
  }

  async getFollowerChange(
    currentCount: number,
    asOf: Date,
  ): Promise<FollowerChange> {
    const compareDate = this.startOfDay(
      new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000),
    );
    const past = await this.prisma.lineFollowerSnapshot.findUnique({
      where: { date: compareDate },
    });

    if (!past || past.followerCount === 0) {
      return { changePercent: null, sinceDate: null };
    }

    const changePercent =
      ((currentCount - past.followerCount) / past.followerCount) * 100;

    return {
      changePercent: Math.round(changePercent * 10) / 10,
      sinceDate: compareDate.toISOString().slice(0, 10),
    };
  }

  private async getOrCreate(): Promise<Company> {
    const existing = await this.prisma.company.findFirst();
    if (existing) return existing;

    return this.prisma.company.create({ data: { name: 'My Company' } });
  }

  private currentPeriod(date = new Date()): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private startOfDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }
}
