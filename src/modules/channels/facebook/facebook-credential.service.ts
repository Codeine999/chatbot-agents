import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FacebookChannel } from '../../../generated/prisma/client';
import {
  openSecret,
  parseSecretKey,
  sealSecret,
} from '../../../infra/crypto/secret-box';
import { PrismaService } from '../../../prisma/prisma.service';
import { CompanyService } from '../../admin/company/company.service';
import {
  CHANNEL_KEY_PATTERN,
  CURRENT_CREDENTIAL_KEY_VERSION,
} from '../../line/channel/line-credential.service';
import { FacebookConfig } from './facebook.config';

export type FacebookCredentials = Readonly<{
  companyId: string;
  pageId: string;
  appSecret: string;
  pageAccessToken: string;
  verifyToken: string;
  source: 'db' | 'env';
}>;

const CACHE_TTL_MS = 60_000;
const PAGE_ID_PATTERN = /^\d{1,32}$/;

/**
 * Where a Facebook Page's secrets come from: the facebookChannels table (one
 * row per company, found by the channelKey in the webhook URL or by the page
 * id), with the old FACEBOOK_* variables as a fallback for the one Page of an
 * existing single-company deployment.
 */
@Injectable()
export class FacebookCredentialService {
  private readonly logger = new Logger(FacebookCredentialService.name);
  private readonly cache = new Map<
    string,
    { value: FacebookCredentials; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly env: FacebookConfig,
    private readonly company: CompanyService,
  ) {}

  /** Webhook URL with a channelKey; null when unknown or unreadable. */
  async forChannelKey(channelKey: string): Promise<FacebookCredentials | null> {
    if (!CHANNEL_KEY_PATTERN.test(channelKey)) return null;
    return this.lookup(`key:${channelKey}`, async () => {
      const row = await this.prisma.facebookChannel.findUnique({
        where: { channelKey },
      });
      return row ? this.fromRow(row) : null;
    });
  }

  /** `entry.id` of a payload, or the page a reply goes out from. */
  async forPageId(pageId: string): Promise<FacebookCredentials | null> {
    if (!PAGE_ID_PATTERN.test(pageId)) return null;
    return this.lookup(`page:${pageId}`, async () => {
      const row = await this.prisma.facebookChannel.findUnique({
        where: { pageId },
      });
      if (row) return this.fromRow(row);
      return this.fromEnv(pageId);
    });
  }

  /** The legacy URL without a channelKey: env settings only. */
  async forLegacyUrl(): Promise<FacebookCredentials | null> {
    const env = this.env.values;
    return env ? this.forPageId(env.pageId) : null;
  }

  hasEnvFallback(): boolean {
    return this.env.values !== null;
  }

  invalidate(): void {
    this.cache.clear();
  }

  seal(plain: string): { ciphertext: string; keyVersion: number } {
    let key: Buffer;
    try {
      key = this.key(CURRENT_CREDENTIAL_KEY_VERSION);
    } catch (error) {
      throw new ServiceUnavailableException((error as Error).message);
    }
    return {
      ciphertext: sealSecret(plain, key),
      keyVersion: CURRENT_CREDENTIAL_KEY_VERSION,
    };
  }

  /** For the admin status view of a stored row. */
  openVerifyToken(row: FacebookChannel): string {
    return openSecret(row.verifyTokenCiphertext, this.key(row.encKeyVersion));
  }

  private async lookup(
    cacheKey: string,
    load: () => Promise<FacebookCredentials | null>,
  ): Promise<FacebookCredentials | null> {
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await load();
    // Misses are not cached, so random keys cannot grow the cache.
    if (value)
      this.cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  private fromRow(row: FacebookChannel): FacebookCredentials | null {
    try {
      const key = this.key(row.encKeyVersion);
      return {
        companyId: row.companyId,
        pageId: row.pageId,
        appSecret: openSecret(row.appSecretCiphertext, key),
        pageAccessToken: openSecret(row.pageAccessTokenCiphertext, key),
        verifyToken: openSecret(row.verifyTokenCiphertext, key),
        source: 'db',
      };
    } catch (error) {
      // Unreadable credentials behave as an unknown Page, never a 500 to Meta.
      this.logger.error(
        `Facebook channel ${row.id} credentials unavailable: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async fromEnv(pageId: string): Promise<FacebookCredentials | null> {
    const env = this.env.values;
    if (!env || env.pageId !== pageId) return null;
    return {
      companyId: await this.company.getCompanyId(),
      pageId,
      appSecret: env.appSecret,
      pageAccessToken: env.pageAccessToken,
      verifyToken: env.verifyToken,
      source: 'env',
    };
  }

  private key(version: number): Buffer {
    return parseSecretKey(
      this.config.get<string>(`CREDENTIAL_ENC_KEY_V${version}`),
    );
  }
}
