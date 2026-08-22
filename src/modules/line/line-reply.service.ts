import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiProviderImage } from '../../ai-provider/types/ai-provider.types';
import { RateLimitService } from '../usage/rate-limit/rate-limit.service';
import { CompanyService } from '../admin/company/company.service';

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

export type LineFollowerInsight = {
  status: 'ready' | 'unready' | 'out_of_service';
  followers?: number;
  targetedReaches?: number;
  blocks?: number;
};

export type LineMessageQuotaConsumption = {
  totalUsage: number;
};

@Injectable()
export class LineService {
  private readonly logger = new Logger(LineService.name);
  private readonly globalReplyLimitPerSec: number;
  private readonly httpTimeoutMs: number;
  private readonly maxImageBytes: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly rateLimitService: RateLimitService,
    private readonly companyService: CompanyService,
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

  async getImageContent(messageId: string): Promise<AiProviderImage> {
    const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.getAccessToken()}`,
        },
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      },
    );

    if (!response.ok) {
      throw new BadGatewayException(
        `Failed to download LINE image status=${response.status}`,
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.maxImageBytes
    ) {
      throw new PayloadTooLargeException('LINE image is too large for AI');
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > this.maxImageBytes) {
      throw new PayloadTooLargeException('LINE image is empty or too large');
    }

    const mediaType = this.resolveImageMediaType(
      response.headers.get('content-type'),
      bytes,
    );

    if (!mediaType) {
      throw new UnsupportedMediaTypeException(
        'Unsupported LINE image media type',
      );
    }

    return {
      mediaType,
      data: bytes.toString('base64'),
    };
  }

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

    await this.companyService.recordOutboundMessage();
    return true;
  }

  private resolveImageMediaType(
    header: string | null,
    bytes: Buffer,
  ): AiProviderImage['mediaType'] | null {
    const mediaType = header?.split(';')[0]?.trim().toLowerCase();

    if (
      mediaType === 'image/jpeg' ||
      mediaType === 'image/png' ||
      mediaType === 'image/webp' ||
      mediaType === 'image/gif'
    ) {
      return mediaType;
    }

    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }

    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return 'image/png';
    }

    if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') {
      return 'image/gif';
    }

    if (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }

    return null;
  }

  private getAccessToken(): string {
    return this.configService.getOrThrow<string>('LINE_CHANNEL_ACCESS_TOKEN');
  }

}
