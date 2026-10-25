import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BanService, type BanInfo } from '../abuse/ban.service';
import { SpamDetectorService } from '../abuse/spam-detector.service';
import {
  RateLimitService,
  type RateLimitResult,
} from '../usage/rate-limit/rate-limit.service';
import { AppApiException, appUnavailable } from './app-errors';
import { APP_LIMITS, AppMessageConfig } from './app-message.config';
import type { AppGuestContext } from './app-request';

const HOUR = 3600;
const DAY = 86_400;
/** Used when a permanent ban gives no remaining time. */
const PERMANENT_RETRY_SEC = 3600;

type Subject = Readonly<{ ipHash: string; contactId?: string }>;

/**
 * Decides whether a public API call may proceed, cheapest check first so a
 * rejected call never reaches the database or the model.
 *
 * Unlike LINE: a Redis outage rejects the call (503) instead of letting it
 * through, and callers are told why (429 + Retry-After). Limits on a network
 * strike the IP; limits on one guest strike only that guest, so one noisy
 * customer cannot get a shared office or mobile network banned.
 */
@Injectable()
export class AppAbuseService {
  private readonly logger = new Logger(AppAbuseService.name);

  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly bans: BanService,
    private readonly spam: SpamDetectorService,
    private readonly prisma: PrismaService,
    private readonly config: AppMessageConfig,
  ) {}

  /** Runs on every request, before anything else touches the database. */
  async assertIpAllowed(ipHash: string): Promise<void> {
    await this.assertNotBanned(`appip:${ipHash}`, { ipHash });
  }

  /** A wrong session token. Throws once the IP's failure budget is spent. */
  async recordInvalidAuth(ipHash: string): Promise<void> {
    const result = await this.consume(
      `rl:app:authfail:${ipHash}`,
      APP_LIMITS.authFailuresPerIpPerMin,
      60,
    );
    if (!result.allowed) await this.blockIp('authfail', { ipHash }, result);
  }

  async assertSessionCreate(ipHash: string): Promise<void> {
    const subject = { ipHash };
    const hourly = await this.consume(
      `rl:app:sess:ip:${ipHash}`,
      this.config.values.sessionCreatePerIpHour,
      HOUR,
    );
    if (!hourly.allowed) await this.blockIp('session-rate', subject, hourly);

    // Bounds the rows one network can keep alive, whatever the rate.
    const active = await this.prisma.appGuestSession.count({
      where: { ipHash, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (active >= APP_LIMITS.maxActiveSessionsPerIp) {
      await this.bans.addStrike(`appip:${ipHash}`, 'too many active sessions');
      this.log('active-sessions', subject);
      throw new AppApiException(
        429,
        'APP_TOO_MANY_SESSIONS',
        'Too many active sessions from this network',
        PERMANENT_RETRY_SEC,
      );
    }
  }

  async assertMessage(guest: AppGuestContext, text: string): Promise<void> {
    const c = this.config.values;
    const subject = { ipHash: guest.ipHash, contactId: guest.contactId };
    const contactKey = `app:${guest.contactId}`;

    await this.assertNotBanned(contactKey, subject);

    const burst = await this.consume(
      `rl:app:msg:c:${guest.contactId}:burst`,
      c.msgBurstPerContact,
      APP_LIMITS.burstWindowSec,
    );
    if (!burst.allowed) await this.blockContact('burst', subject, burst);
    const daily = await this.consume(
      `rl:app:msg:c:${guest.contactId}:day`,
      c.msgDailyPerContact,
      DAY,
    );
    if (!daily.allowed) await this.blockContact('contact-day', subject, daily);

    // Counted across every session of the IP, so creating a fresh session
    // for each message does not reset the budget.
    const perMinute = await this.consume(
      `rl:app:msg:ip:${guest.ipHash}:min`,
      c.msgPerIpMin,
      60,
    );
    if (!perMinute.allowed) await this.blockIp('ip-min', subject, perMinute);
    const perDay = await this.consume(
      `rl:app:msg:ip:${guest.ipHash}:day`,
      c.msgDailyPerIp,
      DAY,
    );
    if (!perDay.allowed) await this.blockIp('ip-day', subject, perDay);

    if (c.msgDailyTotal > 0) {
      const total = await this.consume(
        'rl:app:msg:total:day',
        c.msgDailyTotal,
        DAY,
      );
      if (!total.allowed) this.block('total-day', subject, total);
    }

    const spam = await this.spam.check(contactKey, text);
    if (spam.spam) {
      await this.bans.addStrike(contactKey, spam.reason ?? 'spam');
      this.log('spam', subject);
      throw new AppApiException(
        429,
        'APP_RATE_LIMITED',
        'Message rejected',
        APP_LIMITS.burstWindowSec,
      );
    }
  }

  async assertRead(guest: AppGuestContext): Promise<void> {
    const result = await this.consume(
      `rl:app:read:ip:${guest.ipHash}`,
      APP_LIMITS.readsPerIpPerMin,
      60,
    );
    if (!result.allowed)
      this.block(
        'read',
        { ipHash: guest.ipHash, contactId: guest.contactId },
        result,
      );
  }

  private async consume(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitResult> {
    const result = await this.rateLimit.consume(key, limit, windowSec, 1, {
      failOpen: false,
    });
    if (result.unavailable) throw appUnavailable();
    return result;
  }

  private async assertNotBanned(
    banKey: string,
    subject: Subject,
  ): Promise<void> {
    let info: BanInfo;
    try {
      info = await this.bans.getBanInfo(banKey);
    } catch {
      throw appUnavailable();
    }
    if (!info.banned) return;
    this.log('banned', subject);
    throw new AppApiException(
      429,
      'APP_BANNED',
      'Temporarily blocked',
      info.expiresInSec ?? PERMANENT_RETRY_SEC,
    );
  }

  private async blockIp(
    layer: string,
    subject: Subject,
    result: RateLimitResult,
  ): Promise<never> {
    await this.bans.addStrike(`appip:${subject.ipHash}`, `limit ${layer}`);
    this.block(layer, subject, result);
  }

  private async blockContact(
    layer: string,
    subject: Subject,
    result: RateLimitResult,
  ): Promise<never> {
    await this.bans.addStrike(`app:${subject.contactId}`, `limit ${layer}`);
    this.block(layer, subject, result);
  }

  private block(
    layer: string,
    subject: Subject,
    result: RateLimitResult,
  ): never {
    this.log(layer, subject);
    throw new AppApiException(
      429,
      'APP_RATE_LIMITED',
      'Too many requests',
      result.resetInSec,
    );
  }

  /** Never logs text, tokens or the real address. Grep "app gate blocked" to tune limits. */
  private log(layer: string, subject: Subject): void {
    this.logger.warn(
      `app gate blocked layer=${layer} ip=${subject.ipHash.slice(0, 8)} contact=${subject.contactId ?? '-'}`,
    );
  }
}
