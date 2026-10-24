import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LineChannel } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  openSecret,
  parseSecretKey,
  sealSecret,
} from '../../../infra/crypto/secret-box';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';

export type LineCredentials = Readonly<{
  companyId: string | null;
  secret: string;
  accessToken: string;
  botUserId: string | null;
  source: 'db' | 'env';
}>;

/** Key version new ciphertext is written with: CREDENTIAL_ENC_KEY_V<n>. */
export const CURRENT_CREDENTIAL_KEY_VERSION = 1;
export const CHANNEL_KEY_PATTERN = /^[A-Za-z0-9_-]{16,32}$/;
const CACHE_TTL_MS = 60_000;

@Injectable()
export class LineCredentialService {
  private readonly logger = new Logger(LineCredentialService.name);
  private readonly cache = new Map<
    string,
    { value: LineCredentials; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly scopes: CommerceScopeService,
  ) {}

  /** The channel of this single-company deployment. */
  forDeployment(): Promise<LineCredentials> {
    return this.cached('deployment', async () => {
      const companyId = await this.deploymentCompanyId();
      const row = companyId
        ? await this.prisma.lineChannel.findUnique({ where: { companyId } })
        : null;
      return row ? this.fromRow(row) : this.fromEnv(companyId);
    });
  }

  async forChannelKey(channelKey: string): Promise<LineCredentials | null> {
    if (!CHANNEL_KEY_PATTERN.test(channelKey)) return null;
    const hit = this.cache.get(`key:${channelKey}`);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    // Misses are not cached, so random keys cannot grow the cache.
    const row = await this.prisma.lineChannel.findUnique({
      where: { channelKey },
    });
    if (!row) return null;
    return this.cached(`key:${channelKey}`, () =>
      Promise.resolve(this.fromRow(row)),
    );
  }

  /** Drops every cached value after credentials change. */
  invalidate(): void {
    this.cache.clear();
  }

  /** Encrypts a value with the current key for storage. */
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

  /** True when the environment fallback has both values. */
  hasEnvFallback(): boolean {
    return Boolean(
      this.config.get<string>('LINE_CHANNEL_SECRET') &&
      this.config.get<string>('LINE_CHANNEL_ACCESS_TOKEN'),
    );
  }

  private async cached(
    key: string,
    load: () => Promise<LineCredentials>,
  ): Promise<LineCredentials> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await load();
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  private async deploymentCompanyId(): Promise<string | null> {
    try {
      return (await this.scopes.forLineDeployment()).companyId;
    } catch (error) {
      // No company or more than one: LINE still runs on the environment
      // channel, exactly as it did before credentials moved to the database.
      if (error instanceof HttpException) return null;
      throw error;
    }
  }

  private fromRow(row: LineChannel): LineCredentials {
    try {
      const key = this.key(row.encKeyVersion);
      return {
        companyId: row.companyId,
        secret: openSecret(row.secretCiphertext, key),
        accessToken: openSecret(row.accessTokenCiphertext, key),
        botUserId: row.botUserId,
        source: 'db',
      };
    } catch (error) {
      this.logger.error(
        `LINE channel ${row.id} credentials unavailable: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'LINE channel credentials are unavailable',
      );
    }
  }

  private fromEnv(companyId: string | null): LineCredentials {
    const secret = this.config.get<string>('LINE_CHANNEL_SECRET');
    const accessToken = this.config.get<string>('LINE_CHANNEL_ACCESS_TOKEN');
    if (!secret || !accessToken)
      throw new ServiceUnavailableException('LINE channel is not configured');
    return { companyId, secret, accessToken, botUserId: null, source: 'env' };
  }

  private key(version: number): Buffer {
    return parseSecretKey(
      this.config.get<string>(`CREDENTIAL_ENC_KEY_V${version}`),
    );
  }
}
