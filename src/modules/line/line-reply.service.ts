import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';

export type LineProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
};

@Injectable()
export class LineService {
  private readonly logger = new Logger(LineService.name);
  private readonly globalReplyLimitPerSec: number;
  private readonly httpTimeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly rateLimitService: RateLimitService,
  ) {
    this.globalReplyLimitPerSec = Number(
      configService.get('LINE_GLOBAL_REPLY_LIMIT_PER_SEC') ?? 30,
    );
    this.httpTimeoutMs = Number(
      configService.get('LINE_HTTP_TIMEOUT_MS') ?? 8_000,
    );
  }

  private getAccessToken(): string {
    return this.configService.getOrThrow<string>('LINE_CHANNEL_ACCESS_TOKEN');
  }

  
  async getProfile(lineUserId: string): Promise<LineProfile> {
    const accessToken = this.getAccessToken();

    const response = await fetch(
      `https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('LINE profile error:', errorText);
      throw new InternalServerErrorException('Failed to get LINE profile');
    }

    return response.json() as Promise<LineProfile>;
  }

  /**
   * Replies via the LINE reply API, gated by the global reply limit.
   * Returns false when the reply was dropped by the limiter — a safe drop
   * is preferred over retrying with a reply token that may expire.
   */
  async replyText(replyToken: string, text: string): Promise<boolean> {
    const replyBudget = await this.rateLimitService.consume(
      'rl:line:global:reply',
      this.globalReplyLimitPerSec,
      1,
    );

    if (!replyBudget.allowed) {
      this.logger.warn(
        `global reply limit exceeded: ${replyBudget.current}/${replyBudget.limit} per sec, dropping reply`,
      );
      return false;
    }

    const accessToken = this.getAccessToken();

    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: 'text',
            text,
          },
        ],
      }),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('LINE reply error:', errorText);
      throw new InternalServerErrorException('Failed to reply LINE message');
    }

    return true;
  }

  async pushText(lineUserId: string, text: string): Promise<void> {
    const accessToken = this.getAccessToken();

    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
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

    if (!response.ok) {
      const errorText = await response.text();
      console.error('LINE push error:', errorText);
      throw new InternalServerErrorException('Failed to push LINE message');
    }
  }
}
