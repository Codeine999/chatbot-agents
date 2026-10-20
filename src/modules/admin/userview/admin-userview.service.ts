import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../infra/redis/redis.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChatbotService } from '../../chatbot/chatbot.service';
import { LoadContextService } from '../../chatbot/context/load-context.service';
import { UserSessionService } from '../../users/session/user-session.service';
import type { ChatResponse } from '../../chatbot/shared/types/chat.types';
import type { SendPreviewMessageDto } from './dto/admin-userview.dto';

/** Idle preview sessions disappear with the same window as LINE context. */
const PREVIEW_SESSION_TTL_SEC = 30 * 60;
/** How long a finished turn can be replayed for an HTTP retry. */
const PREVIEW_REQUEST_TTL_SEC = 10 * 60;
/** Upper bound on one turn; a crashed request must not block the session forever. */
const PREVIEW_LOCK_TTL_SEC = 2 * 60;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export type PreviewReply = Readonly<{
  text: string;
  source: ChatResponse['source'];
  contextPolicy: ChatResponse['contextPolicy'];
  catalogRefs?: ChatResponse['catalogRefs'];
}>;

type StoredPreviewRequest =
  | { status: 'PENDING'; sessionId: string }
  | { status: 'DONE'; sessionId: string; reply: PreviewReply };

/**
 * Lets an admin talk to the bot as a customer would, without LINE.
 *
 * Each turn runs through the production `ChatbotService` (router, RAG, AI,
 * credit gate) and is billed to the company wallet on the shared LINE scope.
 * Nothing goes through webhook, queue or delivery, and no LINE chat history
 * is written. The simulated customer is `preview:{adminId}:{sessionId}`, which
 * matches no `LineMember`, so admin handoff and notifications are no-ops and
 * product turns that require a real conversation are skipped.
 */
@Injectable()
export class AdminUserViewService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly chatbot: ChatbotService,
    private readonly context: LoadContextService,
    private readonly sessions: UserSessionService,
  ) {}

  async createSession(adminMemberId: string) {
    const sessionId = randomUUID();
    await this.redis.set(
      this.sessionKey(adminMemberId, sessionId),
      '1',
      'EX',
      PREVIEW_SESSION_TTL_SEC,
    );

    return { sessionId, expiresInSec: PREVIEW_SESSION_TTL_SEC };
  }

  async getSession(adminMemberId: string, sessionId: string) {
    await this.touchSession(adminMemberId, sessionId);
    const userId = this.customerId(adminMemberId, sessionId);
    const workflow = await this.sessions.get(userId);

    return {
      sessionId,
      // Workflow data can hold customer-entered PII; expose only its position.
      workflow: workflow
        ? { flow: workflow.flow, step: workflow.step, status: workflow.status }
        : null,
      context: await this.context.load(userId),
    };
  }

  async deleteSession(adminMemberId: string, sessionId: string) {
    const userId = this.customerId(adminMemberId, sessionId);

    await Promise.all([
      this.sessions.clear(userId),
      this.sessions.resume(userId),
      this.context.clear(userId),
      this.redis.del(this.sessionKey(adminMemberId, sessionId)),
    ]);
  }

  async sendMessage(
    adminMemberId: string,
    sessionId: string,
    body: SendPreviewMessageDto,
  ): Promise<PreviewReply> {
    await this.assertAiEnabled(adminMemberId);
    await this.touchSession(adminMemberId, sessionId);

    const requestKey = this.requestKey(adminMemberId, body.clientRequestId);
    const replay = await this.claimRequest(requestKey, sessionId);
    if (replay) return replay;

    const lockKey = this.lockKey(adminMemberId, sessionId);
    const locked = await this.redis.set(
      lockKey,
      body.clientRequestId,
      'EX',
      PREVIEW_LOCK_TTL_SEC,
      'NX',
    );
    if (!locked) {
      await this.redis.del(requestKey);
      throw new ConflictException(
        'The previous preview message is still being answered',
      );
    }

    try {
      const reply = await this.answer(adminMemberId, sessionId, body);
      await this.redis.set(
        requestKey,
        JSON.stringify({
          status: 'DONE',
          sessionId,
          reply,
        } satisfies StoredPreviewRequest),
        'EX',
        PREVIEW_REQUEST_TTL_SEC,
      );
      return reply;
    } catch (error) {
      // A retry may run again; billing replays by turnId, so it is not re-charged.
      await this.redis.del(requestKey);
      throw error;
    } finally {
      await this.redis.eval(
        RELEASE_LOCK_SCRIPT,
        1,
        lockKey,
        body.clientRequestId,
      );
    }
  }

  private async answer(
    adminMemberId: string,
    sessionId: string,
    body: SendPreviewMessageDto,
  ): Promise<PreviewReply> {
    const userId = this.customerId(adminMemberId, sessionId);
    const recentMessages = await this.context.load(userId);

    // conversationId/lineMemberId stay unset: usage rows store them as UUIDs
    // of real LINE records, and this customer has none.
    const response = await this.chatbot.handleTextMessage({
      userId,
      text: body.text,
      postbackData: body.postbackData,
      turnId: `preview:${adminMemberId}:${body.clientRequestId}`,
      recentMessages,
      preview: true,
    });

    if (response.contextPolicy === 'CLEAR') {
      await this.context.clear(userId);
    } else {
      // There is no delivery step, so the answered turn counts as delivered.
      await this.context.appendTurn({
        conversationId: userId,
        eventId: body.clientRequestId,
        userText: body.text,
        response,
      });
    }

    return {
      text: response.text,
      source: response.source,
      contextPolicy: response.contextPolicy,
      ...(response.catalogRefs ? { catalogRefs: response.catalogRefs } : {}),
    };
  }

  /** Returns the stored reply for a finished retry, or claims a new request. */
  private async claimRequest(
    requestKey: string,
    sessionId: string,
  ): Promise<PreviewReply | undefined> {
    const claimed = await this.redis.set(
      requestKey,
      JSON.stringify({
        status: 'PENDING',
        sessionId,
      } satisfies StoredPreviewRequest),
      'EX',
      PREVIEW_REQUEST_TTL_SEC,
      'NX',
    );
    if (claimed) return undefined;

    const stored = this.parseRequest(await this.redis.get(requestKey));
    if (stored?.sessionId !== sessionId) {
      throw new ConflictException(
        'clientRequestId was already used for another preview session',
      );
    }
    if (stored.status === 'PENDING') {
      throw new ConflictException(
        'This preview message is still being answered',
      );
    }

    return stored.reply;
  }

  private parseRequest(raw: string | null): StoredPreviewRequest | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredPreviewRequest;
    } catch {
      return null;
    }
  }

  private async assertAiEnabled(adminMemberId: string): Promise<void> {
    const admin = await this.prisma.adminMember.findUnique({
      where: { id: adminMemberId },
      select: { aiEnabled: true },
    });

    if (!admin) throw new NotFoundException('Admin member not found');
    if (!admin.aiEnabled) {
      throw new ForbiddenException('AI is disabled for this admin');
    }
  }

  /** Slides the idle TTL; a missing key means the session expired or was never created. */
  private async touchSession(
    adminMemberId: string,
    sessionId: string,
  ): Promise<void> {
    const alive = await this.redis.expire(
      this.sessionKey(adminMemberId, sessionId),
      PREVIEW_SESSION_TTL_SEC,
    );
    if (!alive) throw new NotFoundException('Preview session not found');
  }

  /** Doubles as the context key; it can never collide with a LINE user id (`U…`). */
  private customerId(adminMemberId: string, sessionId: string): string {
    return `preview:${adminMemberId}:${sessionId}`;
  }

  private sessionKey(adminMemberId: string, sessionId: string): string {
    return `preview:session:${adminMemberId}:${sessionId}`;
  }

  private lockKey(adminMemberId: string, sessionId: string): string {
    return `preview:lock:${adminMemberId}:${sessionId}`;
  }

  private requestKey(adminMemberId: string, clientRequestId: string): string {
    return `preview:request:${adminMemberId}:${clientRequestId}`;
  }
}
