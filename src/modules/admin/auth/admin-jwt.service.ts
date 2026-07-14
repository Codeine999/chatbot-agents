import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AdminJwtPayload,
  AdminRole,
  AuthenticatedAdmin,
  isAdminRole,
} from '../../../infra/auth/admin-auth.types';

const DEFAULT_EXPIRES_IN_SECONDS = 8 * 60 * 60;
const JWT_ALGORITHM = 'HS256';

@Injectable()
export class AdminJwtService {
  private readonly secret?: string;
  private readonly expiresInSeconds: number;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.secret = configService.get<string>('ADMIN_JWT_SECRET');

    const configuredExpiry = Number(
      configService.get<string>('ADMIN_JWT_EXPIRES_IN_SECONDS') ??
        DEFAULT_EXPIRES_IN_SECONDS,
    );
    this.expiresInSeconds =
      Number.isInteger(configuredExpiry) && configuredExpiry > 0
        ? configuredExpiry
        : DEFAULT_EXPIRES_IN_SECONDS;
  }

  sign(subject: { id: string; username: string; role: AdminRole }): string {
    const secret = this.getSigningSecret();
    const now = Math.floor(Date.now() / 1000);
    const header = this.encode({ alg: JWT_ALGORITHM, typ: 'JWT' });
    const payload = this.encode({
      sub: subject.id,
      username: subject.username,
      role: subject.role,
      tokenType: 'admin',
      iat: now,
      exp: now + this.expiresInSeconds,
    } satisfies AdminJwtPayload);
    const unsignedToken = `${header}.${payload}`;
    const signature = this.createSignature(unsignedToken, secret);

    return `${unsignedToken}.${signature}`;
  }

  get tokenExpiresInSeconds(): number {
    return this.expiresInSeconds;
  }

  async authenticate(token: string): Promise<AuthenticatedAdmin | null> {
    const payload = this.verify(token);

    if (!payload) return null;

    const admin = await this.prisma.admin.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        picture: true,
        role: true,
      },
    });

    if (!admin || !isAdminRole(admin.role)) return null;

    return {
      ...admin,
      role: admin.role,
    };
  }

  private verify(token: string): AdminJwtPayload | null {
    if (!this.secret) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, presentedSignature] = parts;

    try {
      const header = this.decode(encodedHeader) as Record<string, unknown>;
      if (header.alg !== JWT_ALGORITHM || header.typ !== 'JWT') return null;

      const expectedSignature = this.createSignature(
        `${encodedHeader}.${encodedPayload}`,
        this.secret,
      );
      if (!this.signaturesMatch(presentedSignature, expectedSignature)) {
        return null;
      }

      const payload = this.decode(encodedPayload) as Record<string, unknown>;
      const now = Math.floor(Date.now() / 1000);

      if (
        typeof payload.sub !== 'string' ||
        typeof payload.username !== 'string' ||
        payload.tokenType !== 'admin' ||
        !isAdminRole(payload.role) ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        payload.exp <= now
      ) {
        return null;
      }

      return payload as unknown as AdminJwtPayload;
    } catch {
      return null;
    }
  }

  private getSigningSecret(): string {
    if (!this.secret) {
      throw new InternalServerErrorException(
        'ADMIN_JWT_SECRET is not configured',
      );
    }

    return this.secret;
  }

  private encode(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private decode(value: string): unknown {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  }

  private createSignature(value: string, secret: string): string {
    return createHmac('sha256', secret).update(value).digest('base64url');
  }

  private signaturesMatch(presented: string, expected: string): boolean {
    const presentedBuffer = Buffer.from(presented, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    return (
      presentedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(presentedBuffer, expectedBuffer)
    );
  }
}
