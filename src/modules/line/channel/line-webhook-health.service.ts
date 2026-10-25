import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuthenticatedAdmin } from '../../../shared/guards/admin-auth.types';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';
import { lineApiRequest, webhookUrlFor } from './line-api';
import { LineCredentialService } from './line-credential.service';

const DAY_MS = 24 * 3600_000;
/** LINE waits on our webhook before it answers the test call, so allow longer than a plain read. */
const TEST_TIMEOUT_MS = 20_000;

const endpointSchema = z.object({
  endpoint: z.string().optional(),
  active: z.boolean().optional(),
});
const testSchema = z.object({
  success: z.boolean(),
  timestamp: z.string().optional(),
  statusCode: z.number().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
});

export type WebhookConfiguredState =
  | 'ok'
  | 'mismatch'
  | 'inactive'
  | 'missing'
  | 'unknown';

export type WebhookHealth = {
  /** What LINE should be calling; null until PUBLIC_API_BASE_URL is set. */
  expectedUrl: string | null;
  /** Layer 1: what the LINE console currently has. */
  configured: {
    state: WebhookConfiguredState;
    endpoint: string | null;
    active: boolean | null;
    urlMatched: boolean | null;
  };
  /** Layer 3: real events this deployment has received. */
  live: { lastEventAt: Date | null; eventsLast24h: number };
  checkedAt: Date;
};

/** Layer 2: LINE sent a signed sample event to the configured URL. */
export type WebhookTestResult = {
  success: boolean;
  statusCode: number | null;
  /** LINE's code, e.g. OK, COULD_NOT_CONNECT, REQUEST_TIMEOUT, ERROR_STATUS_CODE. */
  reason: string;
  detail: string | null;
  testedAt: string;
};

const sameUrl = (a: string, b: string) =>
  a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * Answers "is the webhook actually working?" in three independent layers, so a
 * failure points at one cause: the LINE console settings, the network path
 * from LINE to us, or no real traffic yet.
 */
@Injectable()
export class LineWebhookHealthService {
  private readonly httpTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly scopes: CommerceScopeService,
    private readonly credentials: LineCredentialService,
  ) {
    this.httpTimeoutMs = Number(config.get('LINE_HTTP_TIMEOUT_MS') ?? 8_000);
  }

  async check(admin: AuthenticatedAdmin): Promise<WebhookHealth> {
    const { companyId } = await this.scopes.forAdmin(admin);
    const [{ accessToken }, row, last, recent] = await Promise.all([
      this.credentials.forDeployment(),
      this.prisma.lineChannel.findUnique({
        where: { companyId },
        select: { channelKey: true },
      }),
      this.prisma.processedLineWebhookEvent.findFirst({
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true },
      }),
      this.prisma.processedLineWebhookEvent.count({
        where: { processedAt: { gte: new Date(Date.now() - DAY_MS) } },
      }),
    ]);
    const expectedUrl = webhookUrlFor(this.config, row?.channelKey ?? null);

    return {
      expectedUrl,
      configured: await this.readConfigured(accessToken, expectedUrl),
      live: { lastEventAt: last?.processedAt ?? null, eventsLast24h: recent },
      checkedAt: new Date(),
    };
  }

  async test(admin: AuthenticatedAdmin): Promise<WebhookTestResult> {
    const { companyId } = await this.scopes.forAdmin(admin);
    const { accessToken } = await this.credentials.forDeployment();

    // No endpoint in the body: LINE tests the URL its console really has,
    // which is the one that matters for real traffic.
    const response = await this.call(
      'POST',
      '/v2/bot/channel/webhook/test',
      accessToken,
      {},
      TEST_TIMEOUT_MS,
    );
    if (response.status === 401 || response.status === 403)
      throw new BadRequestException('LINE access token is invalid');
    if (!response.ok)
      throw new BadGatewayException(
        `LINE could not run the webhook test (HTTP ${response.status})`,
      );
    const parsed = testSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new BadGatewayException('LINE returned an unexpected test result');

    const result = parsed.data;
    // The flag reflects the latest test, so a webhook that stops working shows up.
    await this.prisma.lineChannel.updateMany({
      where: { companyId },
      data: { webhookSetAt: result.success ? new Date() : null },
    });
    return {
      success: result.success,
      statusCode: result.statusCode ?? null,
      reason: result.reason ?? (result.success ? 'OK' : 'UNKNOWN'),
      detail: result.detail ?? null,
      testedAt: result.timestamp ?? new Date().toISOString(),
    };
  }

  private async readConfigured(
    accessToken: string,
    expectedUrl: string | null,
  ): Promise<WebhookHealth['configured']> {
    const unknown = {
      state: 'unknown' as const,
      endpoint: null,
      active: null,
      urlMatched: null,
    };
    let body: unknown;
    try {
      const response = await this.call(
        'GET',
        '/v2/bot/channel/webhook/endpoint',
        accessToken,
      );
      if (!response.ok) return unknown;
      body = await response.json();
    } catch {
      return unknown;
    }
    const parsed = endpointSchema.safeParse(body);
    if (!parsed.success) return unknown;

    const endpoint = parsed.data.endpoint?.trim() || null;
    const active = parsed.data.active ?? null;
    const urlMatched =
      endpoint && expectedUrl ? sameUrl(endpoint, expectedUrl) : null;
    const state: WebhookConfiguredState = !endpoint
      ? 'missing'
      : urlMatched === false
        ? 'mismatch'
        : active === false
          ? 'inactive'
          : 'ok';
    return { state, endpoint, active, urlMatched };
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    body?: unknown,
    timeoutMs = this.httpTimeoutMs,
  ): Promise<Response> {
    try {
      return await lineApiRequest(method, path, accessToken, timeoutMs, body);
    } catch {
      throw new BadGatewayException('LINE could not be reached');
    }
  }
}
