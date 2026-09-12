import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getJson } from '../utils';
import { RateLimitService } from '../../usage/rate-limit/rate-limit.service';
import { CompanyService } from '../../admin/company/company.service';
import { AiProviderSettingsService } from '../../ai/ai-provider-settings.service';
import type { AiProviderRuntimeSetting } from '../../../ai-provider/types/ai-provider.types';
import { LineDeliveryError } from '../line-delivery.error';
import { randomUUID } from 'node:crypto';

export type LineProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
};

export type LineBotInfo = {
  userId: string;
  basicId: string;
  premiumId?: string;
  displayName: string;
  pictureUrl?: string;
  chatMode: 'chat' | 'bot';
  markAsReadMode: 'auto' | 'manual';
};

export type LineBotInfoWithAiProviderSettings = LineBotInfo & {
  aiProviderSettings: readonly AiProviderRuntimeSetting[];
};

export type LineFollowerInsight = {
  status: 'ready' | 'unready' | 'out_of_service';
  followers?: number;
  targetedReaches?: number;
  blocks?: number;
};

export type LineMessageQuotaConsumption = {
  totalUsage: number;
};

export type LineMessageQuota = {
  /** `none` means the plan has no push-message cap, so `value` is absent. */
  type: 'none' | 'limited';
  value?: number;
};

@Injectable()
export class LineAdminService {
  private readonly logger = new Logger(LineAdminService.name);
  private readonly globalReplyLimitPerSec: number;
  private readonly httpTimeoutMs: number;
  private readonly maxImageBytes: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly rateLimitService: RateLimitService,
    private readonly companyService: CompanyService,
    private readonly aiProviderSettingsService: AiProviderSettingsService,
  ) {
    this.globalReplyLimitPerSec = Number(
      configService.get('LINE_GLOBAL_REPLY_LIMIT_PER_SEC') ?? 30,
    );
    this.httpTimeoutMs = Number(
      configService.get('LINE_HTTP_TIMEOUT_MS') ?? 8_000,
    );
    this.maxImageBytes = Number(
      configService.get('LINE_AI_IMAGE_MAX_BYTES') ?? 8 * 1024 * 1024,
    );
  }

  async getProfile(lineUserId: string): Promise<LineProfile> {
    return getJson<LineProfile>(
      `/v2/bot/profile/${encodeURIComponent(lineUserId)}`,
      'LINE profile',
      this.getAccessToken(),
      this.httpTimeoutMs,
    );
  }

  async getBotInfo(): Promise<LineBotInfoWithAiProviderSettings> {
    const [botInfo, aiProviderSettings] = await Promise.all([
      getJson<LineBotInfo>(
        '/v2/bot/info',
        'LINE bot info',
        this.getAccessToken(),
        this.httpTimeoutMs,
      ),
      this.aiProviderSettingsService.getAll(),
    ]);

    return { ...botInfo, aiProviderSettings };
  }

  async getFollowerInsight(date: string): Promise<LineFollowerInsight> {
    return getJson<LineFollowerInsight>(
      `/v2/bot/insight/followers?date=${encodeURIComponent(date)}`,
      'LINE follower insight',
      this.getAccessToken(),
      this.httpTimeoutMs,
    );
  }

  /** Monthly push-message allowance of the LINE plan. */
  async getMessageQuota(): Promise<LineMessageQuota> {
    return getJson<LineMessageQuota>(
      '/v2/bot/message/quota',
      'LINE message quota',
      this.getAccessToken(),
      this.httpTimeoutMs,
    );
  }

  async getMessageQuotaConsumption(): Promise<LineMessageQuotaConsumption> {
    return getJson<LineMessageQuotaConsumption>(
      '/v2/bot/message/quota/consumption',
      'LINE message quota consumption',
      this.getAccessToken(),
      this.httpTimeoutMs,
    );
  }

  async pushText(lineUserId: string, text: string, retryKey: string = randomUUID()): Promise<void> {
    const accessToken = this.getAccessToken();

    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Line-Retry-Key': retryKey,
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [
          {
            type: 'text',
            text,
          },
        ],
      }),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });

    if (response.status === 409 && response.headers.get('x-line-accepted-request-id')) return;
    if (!response.ok) {
      const errorText = await response.text();
      console.error('LINE push error:', errorText);
      throw new LineDeliveryError(
        `LINE push HTTP ${response.status}: ${errorText.slice(0, 500)}`,
        response.status >= 500 ? 'UNKNOWN' : 'REJECTED',
        response.status >= 500,
      );
    }

    await this.companyService.recordOutboundMessage().catch((error: unknown) =>
      this.logger.error(`LINE accepted push; outbound counter failed: ${String(error)}`),
    );
  }

  private getAccessToken(): string {
    return this.configService.getOrThrow<string>('LINE_CHANNEL_ACCESS_TOKEN');
  }

}
