import { randomBytes } from 'node:crypto';
import { publicApiBaseUrl } from '../../core/public-api-base-url';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import type { AuthenticatedAdmin } from '../../../../shared/guards/admin-auth.types';
import { CommerceScopeService } from '../../../commerce/commerce-scope.service';
import { FacebookConfig } from '../facebook.config';
import { FacebookCredentialService } from '../facebook-credential.service';
import { connectFacebookChannelSchema } from './facebook-channel.dto';

const pageNameSchema = z.object({ name: z.string().max(255).optional() });

/** What Graph's debug_token says about a token; needs no page permission. */
const debugTokenSchema = z.object({
  data: z.object({
    app_id: z.string().regex(/^\d{1,32}$/),
    type: z.string(),
    is_valid: z.boolean(),
    profile_id: z
      .string()
      .regex(/^\d{1,32}$/)
      .optional(),
  }),
});

/** Machine-readable reasons the connect form can act on. */
export const FACEBOOK_CONNECT_ERRORS = {
  invalidToken: 'FB_INVALID_TOKEN',
  notPageToken: 'FB_NOT_PAGE_TOKEN',
  appSecretMismatch: 'FB_APP_SECRET_MISMATCH',
} as const;

const badRequest = (message: string, code: string) =>
  new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message,
    code,
  });

/** Every column except the encrypted values. */
const PUBLIC_SELECT = {
  id: true,
  channelKey: true,
  pageId: true,
  pageName: true,
  appSecretLast4: true,
  pageAccessTokenLast4: true,
  verifiedAt: true,
  webhookSetAt: true,
  updatedAt: true,
} as const;
type PublicFacebookChannel = Prisma.FacebookChannelGetPayload<{
  select: typeof PUBLIC_SELECT;
}>;

export type FacebookSubscription = { ok: boolean; reason?: string };

/**
 * Lets a company owner connect their own Facebook Page. The token is checked
 * with Graph before anything is stored, values are encrypted at rest, and
 * responses only ever show the last four characters. The webhook callback URL
 * and verify token are entered once in the Meta app dashboard.
 */
@Injectable()
export class FacebookChannelAdminService {
  private readonly logger = new Logger(FacebookChannelAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly facebook: FacebookConfig,
    private readonly scopes: CommerceScopeService,
    private readonly credentials: FacebookCredentialService,
  ) {}

  async status(admin: AuthenticatedAdmin) {
    const { companyId } = await this.scopes.forAdmin(admin);
    return this.view(companyId);
  }

  async connect(admin: AuthenticatedAdmin, body: unknown) {
    const input = connectFacebookChannelSchema.parse(body);
    // Fails with 503 before any Graph call when the encryption key is missing.
    const appSecret = this.credentials.seal(input.appSecret);
    const token = this.credentials.seal(input.pageAccessToken);
    const verifyToken = randomBytes(24).toString('base64url');
    const sealedVerify = this.credentials.seal(verifyToken);
    const page = await this.fetchPage(input.pageAccessToken, input.appSecret);
    const { companyId } = await this.scopes.forAdmin(admin);

    const values = {
      pageId: page.id,
      pageName: page.name ?? null,
      appSecretCiphertext: appSecret.ciphertext,
      pageAccessTokenCiphertext: token.ciphertext,
      encKeyVersion: appSecret.keyVersion,
      appSecretLast4: input.appSecret.slice(-4),
      pageAccessTokenLast4: input.pageAccessToken.slice(-4),
      verifiedAt: new Date(),
      // Cleared on every save so the flag only reflects the latest token.
      webhookSetAt: null,
      updatedByAdminId: admin.id,
    };
    const row = await this.save(companyId, values, {
      channelKey: randomBytes(16).toString('base64url'),
      verifyTokenCiphertext: sealedVerify.ciphertext,
    });
    this.credentials.invalidate();
    this.logger.log(`Facebook channel ${row.id} updated by admin ${admin.id}`);

    const subscription = await this.subscribe(input.pageAccessToken);
    if (subscription.ok)
      await this.prisma.facebookChannel.update({
        where: { id: row.id },
        data: { webhookSetAt: new Date() },
      });
    return { ...(await this.view(companyId)), subscription };
  }

  async disconnect(admin: AuthenticatedAdmin) {
    const { companyId } = await this.scopes.forAdmin(admin);
    const { count } = await this.prisma.facebookChannel.deleteMany({
      where: { companyId },
    });
    if (!count) throw new NotFoundException('Facebook Page is not connected');
    this.credentials.invalidate();
    this.logger.log(`Facebook channel of ${companyId} removed by ${admin.id}`);
    return { disconnected: true };
  }

  /**
   * Upsert that survives two writes racing for the same company: the loser
   * hits the unique key and updates the winner's row. A second conflict means
   * the Page belongs to another company. channelKey and verify token are only
   * written on create, so the URL and token entered in Meta never change.
   */
  private async save(
    companyId: string,
    values: Omit<
      Prisma.FacebookChannelUncheckedCreateInput,
      'companyId' | 'channelKey' | 'verifyTokenCiphertext'
    >,
    onCreate: { channelKey: string; verifyTokenCiphertext: string },
  ): Promise<PublicFacebookChannel> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.facebookChannel.upsert({
          where: { companyId },
          create: { companyId, ...onCreate, ...values },
          update: values,
          select: PUBLIC_SELECT,
        });
      } catch (error) {
        const conflict =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        if (!conflict) throw error;
        if (attempt === 1)
          throw new ConflictException(
            'This Facebook Page is already connected to another company',
          );
      }
    }
  }

  private async view(companyId: string) {
    const row = await this.prisma.facebookChannel.findUnique({
      where: { companyId },
    });
    const envFallback = this.credentials.hasEnvFallback();
    return {
      connected: Boolean(row) || envFallback,
      source: row ? 'db' : envFallback ? 'env' : 'none',
      pageId: row?.pageId ?? null,
      pageName: row?.pageName ?? null,
      appSecretLast4: row?.appSecretLast4 ?? null,
      pageAccessTokenLast4: row?.pageAccessTokenLast4 ?? null,
      webhookUrl: row ? this.webhookUrl(row.channelKey) : null,
      // Entered once in the Meta dashboard; only this company's admins see it.
      verifyToken: row ? this.credentials.openVerifyToken(row) : null,
      verifiedAt: row?.verifiedAt ?? null,
      webhookSetAt: row?.webhookSetAt ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  private webhookUrl(channelKey: string): string {
    return `${publicApiBaseUrl(this.config)}/api/channels/facebook/webhooks/${channelKey}`;
  }

  /**
   * Checks the token with Graph's debug_token, which works for a token that
   * only has pages_messaging (what the Messenger "Generate token" button
   * issues). The token proves which app and Page it belongs to, then the app
   * secret is proven against that same app. The Page name is a best effort:
   * it needs pages_read_engagement, so a token without it just has no name.
   */
  private async fetchPage(pageAccessToken: string, appSecret: string) {
    const token = await this.inspectToken(pageAccessToken, pageAccessToken);
    if (!token.is_valid)
      throw badRequest(
        'Facebook page access token is invalid',
        FACEBOOK_CONNECT_ERRORS.invalidToken,
      );
    if (token.type !== 'PAGE' || !token.profile_id)
      throw badRequest(
        'Facebook token is not a Page access token',
        FACEBOOK_CONNECT_ERRORS.notPageToken,
      );

    // An app access token (<app id>|<secret>) is only accepted with the right
    // secret, so this also proves the secret belongs to the token's app.
    try {
      await this.inspectToken(pageAccessToken, `${token.app_id}|${appSecret}`);
    } catch (error) {
      if (error instanceof BadRequestException)
        throw badRequest(
          'Facebook app secret does not belong to the app that issued this token',
          FACEBOOK_CONNECT_ERRORS.appSecretMismatch,
        );
      throw error;
    }

    return {
      id: token.profile_id,
      name: await this.fetchPageName(pageAccessToken),
    };
  }

  private async inspectToken(inputToken: string, accessToken: string) {
    let response: Response;
    try {
      response = await this.graph(
        'GET',
        `/debug_token?input_token=${encodeURIComponent(inputToken)}`,
        accessToken,
      );
    } catch {
      throw new BadGatewayException('Facebook could not be reached');
    }
    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403
    )
      throw badRequest(
        'Facebook page access token is invalid',
        FACEBOOK_CONNECT_ERRORS.invalidToken,
      );
    if (!response.ok)
      throw new BadGatewayException(
        `Facebook did not confirm the token (HTTP ${response.status})`,
      );
    const parsed = debugTokenSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success)
      throw new BadGatewayException(
        'Facebook returned an unexpected token description',
      );
    return parsed.data.data;
  }

  private async fetchPageName(pageAccessToken: string) {
    try {
      const response = await this.graph(
        'GET',
        '/me?fields=name',
        pageAccessToken,
      );
      if (!response.ok) return undefined;
      const parsed = pageNameSchema.safeParse(
        await response.json().catch(() => null),
      );
      return parsed.success ? parsed.data.name : undefined;
    } catch {
      return undefined;
    }
  }

  /** Subscribes the app to the Page's messages. Non-fatal: reported to the UI. */
  private async subscribe(
    pageAccessToken: string,
  ): Promise<FacebookSubscription> {
    try {
      const response = await this.graph(
        'POST',
        '/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks',
        pageAccessToken,
      );
      return response.ok
        ? { ok: true }
        : {
            ok: false,
            reason: `Facebook refused the subscription (HTTP ${response.status}); subscribe the Page in the Meta dashboard`,
          };
    } catch {
      return { ok: false, reason: 'Facebook could not be reached' };
    }
  }

  private graph(method: 'GET' | 'POST', path: string, bearer: string) {
    const { graphBaseUrl, sendTimeoutMs } = this.facebook.transport;
    return fetch(`${graphBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(sendTimeoutMs),
    });
  }
}
