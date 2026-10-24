import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuthenticatedAdmin } from '../../../shared/guards/admin-auth.types';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';
import { connectLineChannelSchema } from './dto/line-channel.dto';
import { LineCredentialService } from './line-credential.service';

const LINE_API = 'https://api.line.me';

const botInfoSchema = z.object({
  userId: z.string().min(1).max(40),
  basicId: z.string().max(40).optional(),
  displayName: z.string().max(255).optional(),
});
const webhookTestSchema = z.object({
  success: z.boolean(),
  statusCode: z.number().optional(),
  reason: z.string().optional(),
});

/** Every column except the encrypted values. */
const PUBLIC_SELECT = {
  id: true,
  channelKey: true,
  channelId: true,
  botUserId: true,
  basicId: true,
  displayName: true,
  secretLast4: true,
  accessTokenLast4: true,
  verifiedAt: true,
  webhookSetAt: true,
  updatedAt: true,
} as const;
type PublicLineChannel = Prisma.LineChannelGetPayload<{
  select: typeof PUBLIC_SELECT;
}>;

export type LineWebhookSetup = {
  url: string | null;
  ok: boolean;
  reason?: string;
};

/**
 * Lets a company owner connect their own LINE OA. The token is verified with
 * LINE before anything is stored, values are encrypted at rest, and responses
 * only ever show the last four characters.
 */
@Injectable()
export class LineChannelAdminService {
  private readonly logger = new Logger(LineChannelAdminService.name);
  private readonly httpTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly scopes: CommerceScopeService,
    private readonly credentials: LineCredentialService,
  ) {
    this.httpTimeoutMs = Number(config.get('LINE_HTTP_TIMEOUT_MS') ?? 8_000);
  }

  async status(admin: AuthenticatedAdmin) {
    const { companyId } = await this.scopes.forAdmin(admin);
    const row = await this.prisma.lineChannel.findUnique({
      where: { companyId },
      select: PUBLIC_SELECT,
    });
    return this.view(row);
  }

  async connect(admin: AuthenticatedAdmin, body: unknown) {
    const input = connectLineChannelSchema.parse(body);
    // Fails with 503 before any LINE call when the encryption key is missing.
    const secret = this.credentials.seal(input.channelSecret);
    const token = this.credentials.seal(input.accessToken);
    const bot = await this.fetchBotInfo(input.accessToken);
    const { companyId } = await this.scopes.forAdmin(admin);

    const values = {
      channelId: input.channelId ?? null,
      botUserId: bot.userId,
      basicId: bot.basicId ?? null,
      displayName: bot.displayName ?? null,
      secretCiphertext: secret.ciphertext,
      accessTokenCiphertext: token.ciphertext,
      encKeyVersion: secret.keyVersion,
      secretLast4: input.channelSecret.slice(-4),
      accessTokenLast4: input.accessToken.slice(-4),
      verifiedAt: new Date(),
      updatedByAdminId: admin.id,
    };
    let row: PublicLineChannel;
    try {
      row = await this.prisma.lineChannel.upsert({
        where: { companyId },
        // The key stays fixed across updates so the webhook URL never changes.
        create: {
          companyId,
          channelKey: randomBytes(16).toString('base64url'),
          ...values,
        },
        update: values,
        select: PUBLIC_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'This LINE channel is already connected to another company',
        );
      throw error;
    }
    this.credentials.invalidate();
    this.logger.log(`LINE channel ${row.id} updated by admin ${admin.id}`);

    const webhook = await this.setUpWebhook(row.channelKey, input.accessToken);
    if (webhook.ok)
      row = await this.prisma.lineChannel.update({
        where: { id: row.id },
        data: { webhookSetAt: new Date() },
        select: PUBLIC_SELECT,
      });
    return { ...this.view(row), webhook };
  }

  private view(row: PublicLineChannel | null) {
    const envFallback = this.credentials.hasEnvFallback();
    return {
      connected: Boolean(row) || envFallback,
      source: row ? 'db' : envFallback ? 'env' : 'none',
      channelId: row?.channelId ?? null,
      botUserId: row?.botUserId ?? null,
      basicId: row?.basicId ?? null,
      displayName: row?.displayName ?? null,
      secretLast4: row?.secretLast4 ?? null,
      accessTokenLast4: row?.accessTokenLast4 ?? null,
      webhookUrl: row ? this.webhookUrl(row.channelKey) : null,
      verifiedAt: row?.verifiedAt ?? null,
      webhookSetAt: row?.webhookSetAt ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  private webhookUrl(channelKey: string): string | null {
    const base = this.config.get<string>('PUBLIC_API_BASE_URL')?.trim();
    return base
      ? `${base.replace(/\/+$/, '')}/api/line/webhooks/${channelKey}`
      : null;
  }

  private async fetchBotInfo(accessToken: string) {
    let response: Response;
    try {
      response = await this.lineRequest('GET', '/v2/bot/info', accessToken);
    } catch {
      throw new BadGatewayException('LINE could not be reached');
    }
    if (response.status === 401 || response.status === 403)
      throw new BadRequestException('LINE access token is invalid');
    if (!response.ok)
      throw new BadGatewayException(
        `LINE did not confirm the access token (HTTP ${response.status})`,
      );
    const parsed = botInfoSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new BadGatewayException('LINE returned an unexpected bot profile');
    return parsed.data;
  }

  /**
   * Points the channel's webhook at this deployment and asks LINE to send a
   * signed test event. A passing test also proves the channel secret.
   */
  private async setUpWebhook(
    channelKey: string,
    accessToken: string,
  ): Promise<LineWebhookSetup> {
    const url = this.webhookUrl(channelKey);
    if (!url)
      return {
        url,
        ok: false,
        reason:
          'PUBLIC_API_BASE_URL is not set; enter the webhook URL in LINE Developers',
      };
    try {
      const set = await this.lineRequest(
        'PUT',
        '/v2/bot/channel/webhook/endpoint',
        accessToken,
        { endpoint: url },
      );
      if (!set.ok)
        return {
          url,
          ok: false,
          reason: `LINE refused the webhook URL (HTTP ${set.status})`,
        };
      const test = await this.lineRequest(
        'POST',
        '/v2/bot/channel/webhook/test',
        accessToken,
        { endpoint: url },
      );
      const result = webhookTestSchema.safeParse(
        test.ok ? await test.json() : null,
      );
      if (result.success && result.data.success) return { url, ok: true };
      return {
        url,
        ok: false,
        reason: result.success
          ? `Webhook test failed: ${result.data.reason ?? 'unknown'} (${result.data.statusCode ?? '-'}); check the channel secret`
          : `LINE webhook test HTTP ${test.status}`,
      };
    } catch {
      return { url, ok: false, reason: 'LINE could not be reached' };
    }
  }

  private lineRequest(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    accessToken: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${LINE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
  }
}
