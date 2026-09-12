import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LineDelivery, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LoadContextService, AppendContextTurnParams } from '../chatbot/context/load-context.service';
import { LineService } from './line-reply.service';
import { LineAdminService } from './admin/line-admin.service';
import { LineDeliveryError } from './line-delivery.error';

@Injectable()
export class LineDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LineDeliveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly line: LineService,
    private readonly adminLine: LineAdminService,
    private readonly context: LoadContextService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.recover(), 5_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async recover() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = new Date();
      const rows = await this.prisma.lineDelivery.findMany({
        where: { OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'SENDING', leaseUntil: { lt: now } },
          { status: 'ACCEPTED', finalizedAt: null },
        ] }, take: 20, orderBy: { createdAt: 'asc' },
      });
      for (const row of rows) {
        try { await this.deliver(row.id); }
        catch (error) { this.logger.error(`Delivery ${row.id}: ${String(error)}`); }
      }
    } catch (error) { this.logger.error(`Delivery recovery: ${String(error)}`); }
    finally { this.busy = false; }
  }

  async deliver(id: string): Promise<void> {
    let row = await this.prisma.lineDelivery.findUniqueOrThrow({ where: { id } });
    if (row.status === 'ACCEPTED') { await this.finalize(row); return; }
    const now = new Date();
    const owner = randomUUID();
    const claimed = await this.prisma.lineDelivery.updateMany({
      where: { id, OR: [
        { status: 'PENDING', nextAttemptAt: { lte: now } },
        { status: 'SENDING', leaseUntil: { lt: now } },
      ] },
      data: { status: 'SENDING', leaseOwner: owner, leaseUntil: new Date(Date.now() + 120_000), attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    // A previous reply attempt might already have been accepted. Reply has no retry key.
    if (row.status === 'SENDING' && row.method === 'REPLY') {
      await this.finishAttempt(id, owner, { status: 'UNKNOWN', lastError: 'Worker stopped during reply; acceptance unknown' });
      return;
    }
    row = await this.prisma.lineDelivery.findUniqueOrThrow({ where: { id } });
    let method = row.method;
    try {
      if (method === 'REPLY' && row.replyToken && row.replyUntil && row.replyUntil > now) {
        try {
          if (await this.line.replyText(row.replyToken, row.text)) {
            await this.accept(row, owner); return;
          }
        } catch (error) {
          if (!(error instanceof LineDeliveryError && error.replyTokenInvalid)) throw error;
          // Only a definitive invalid-token response permits fallback here.
        }
      }
      method = 'PUSH';
      if (row.firstPushAt && Date.now() - row.firstPushAt.getTime() >= 23 * 3600_000) {
        await this.finishAttempt(id, owner, { status: 'UNKNOWN', lastError: 'Push retry key is near expiry; manual review required' });
        return;
      }
      const transition = await this.prisma.lineDelivery.updateMany({
        where: { id, leaseOwner: owner, status: 'SENDING' },
        data: { method: 'PUSH', firstPushAt: row.firstPushAt ?? new Date() },
      });
      if (!transition.count) return;
      await this.adminLine.pushText(row.lineUserId, row.text, row.retryKey);
      await this.accept(row, owner);
    } catch (error) {
      const retryable = method === 'PUSH' &&
        (!(error instanceof LineDeliveryError) || error.retryable);
      const retry = retryable && row.attempts < 8;
      await this.finishAttempt(id, owner, {
        status: retry ? 'PENDING' : error instanceof LineDeliveryError && error.outcome === 'REJECTED' ? 'FAILED' : 'UNKNOWN',
        method,
        nextAttemptAt: new Date(Date.now() + Math.min(60_000, 2_000 * 2 ** (row.attempts - 1))),
        lastError: String(error).slice(0, 1000),
      });
    }
  }

  private async accept(row: LineDelivery, owner: string) {
    const updated = await this.finishAttempt(row.id, owner, { status: 'ACCEPTED', acceptedAt: new Date(), lastError: null });
    if (updated.count) {
      // Finalization failures must never change an accepted delivery back to pending.
      try { await this.finalize(await this.prisma.lineDelivery.findUniqueOrThrow({ where: { id: row.id } })); }
      catch (error) { this.logger.error(`Accepted delivery ${row.id}: history recovery needed: ${String(error)}`); }
    }
  }

  private finishAttempt(id: string, owner: string, data: Prisma.LineDeliveryUpdateManyMutationInput) {
    return this.prisma.lineDelivery.updateMany({
      where: { id, leaseOwner: owner, status: 'SENDING' },
      data: { ...data, leaseOwner: null, leaseUntil: null },
    });
  }

  private async finalize(row: LineDelivery) {
    // Unique deliveryId makes repairing history safe after a crash.
    await this.prisma.$transaction(async (tx) => {
      await tx.lineChatHistory.upsert({
        where: { deliveryId: row.id }, update: {},
        create: {
          deliveryId: row.id, conversationId: row.conversationId, lineMemberId: row.lineMemberId,
          sender: row.adminMemberId ? 'ADMIN' : 'SYSTEM', sentByAdminId: row.adminMemberId,
          messageType: 'TEXT', text: row.text, sentStatus: 'sent',
          createdAt: row.acceptedAt ?? new Date(),
        },
      });
      // A delayed repair must not overwrite a newer conversation preview.
      await tx.lineConversation.updateMany({
        where: { id: row.conversationId, lastMessageAt: { lte: row.acceptedAt ?? new Date() } },
        data: { lastMessage: row.text, lastMessageType: 'TEXT', lastMessageAt: row.acceptedAt ?? new Date() },
      });
    });
    if (row.context) {
      const turn = row.context as unknown as AppendContextTurnParams;
      if (turn.response.contextPolicy === 'INCLUDE') await this.context.appendTurn(turn);
      // CLEAR is done when the response is persisted, not on delayed delivery repair.
    }
    await this.prisma.lineDelivery.update({ where: { id: row.id }, data: { finalizedAt: new Date() } });
  }
}
