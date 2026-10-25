import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CompanyService } from '../admin/company/company.service';
import { UserSessionService } from '../users/session/user-session.service';
import { AppAbuseService } from './app-abuse.service';
import { APP_LIMITS, AppMessageConfig } from './app-message.config';
import type { AppGuestContext } from './app-request';
import type { CreateSessionDto } from './dto/app-session.dto';

const DAY_MS = 86_400_000;
/** 'ags_' + 32 random bytes as base64url. */
export const SESSION_TOKEN_PATTERN = /^ags_[A-Za-z0-9_-]{43}$/;

export type AuthenticatedGuest = Readonly<{
  sessionId: string;
  contactId: string;
  companyId: string;
  expiresAt: Date;
}>;

export const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** The guest's Redis identity: session, mute, ban and spam keys. */
export const appUserId = (contactId: string) => `app:${contactId}`;

@Injectable()
export class AppSessionService {
  private readonly logger = new Logger(AppSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppMessageConfig,
    private readonly abuse: AppAbuseService,
    private readonly sessions: UserSessionService,
    private readonly company: CompanyService,
  ) {}

  /** The token is returned once; only its hash is stored. */
  async create(ipHash: string, dto: CreateSessionDto) {
    await this.abuse.assertSessionCreate(ipHash);

    // Billing and the chat pipeline serve the deployment's single company.
    const companyId = await this.company.getCompanyId();
    const token = `ags_${randomBytes(32).toString('base64url')}`;
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.values.sessionTtlDays * DAY_MS,
    );
    const contact = await this.prisma.$transaction(async (tx) => {
      const created = await tx.channelContact.create({
        data: {
          companyId,
          channel: 'APP',
          displayName: dto.displayName || null,
          metadata: dto.metadata ?? Prisma.JsonNull,
          lastActiveAt: now,
        },
        select: { id: true },
      });
      await tx.appGuestSession.create({
        data: {
          companyId,
          contactId: created.id,
          tokenHash: hashSessionToken(token),
          ipHash,
          expiresAt,
          lastSeenAt: now,
        },
      });
      return created;
    });
    return { sessionToken: token, guestId: contact.id, expiresAt };
  }

  /** Valid sessions slide forward, never past the maximum age counted from creation. */
  async authenticate(token: string): Promise<AuthenticatedGuest | null> {
    if (!SESSION_TOKEN_PATTERN.test(token)) return null;
    const session = await this.prisma.appGuestSession.findUnique({
      where: { tokenHash: hashSessionToken(token) },
    });
    if (!session) return null;

    const now = Date.now();
    const hardLimit =
      session.createdAt.getTime() + APP_LIMITS.sessionMaxAgeDays * DAY_MS;
    if (
      session.revokedAt ||
      session.expiresAt.getTime() <= now ||
      hardLimit <= now
    )
      return null;

    let expiresAt = session.expiresAt;
    if (
      !session.lastSeenAt ||
      now - session.lastSeenAt.getTime() >= APP_LIMITS.sessionTouchSec * 1000
    ) {
      expiresAt = new Date(
        Math.min(now + this.config.values.sessionTtlDays * DAY_MS, hardLimit),
      );
      try {
        await this.prisma.appGuestSession.update({
          where: { id: session.id },
          data: { lastSeenAt: new Date(now), expiresAt },
        });
      } catch (error) {
        // Renewal is best effort; the request itself is still valid.
        this.logger.warn(
          `session touch failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
    return {
      sessionId: session.id,
      contactId: session.contactId,
      companyId: session.companyId,
      expiresAt,
    };
  }

  async describe(guest: AppGuestContext) {
    const conversation = await this.prisma.channelConversation.findUnique({
      where: { contactId: guest.contactId },
      select: { id: true },
    });
    return {
      guestId: guest.contactId,
      conversationId: conversation?.id ?? null,
      botMode: await this.botMode(guest.contactId),
      expiresAt: guest.expiresAt,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.appGuestSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async botMode(contactId: string): Promise<'auto' | 'admin'> {
    return (await this.sessions.isMuted(appUserId(contactId)))
      ? 'admin'
      : 'auto';
  }
}
