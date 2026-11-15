import { randomUUID } from 'node:crypto';
import { Prisma } from '../../../../generated/prisma/client';
import type { PrismaService } from '../../../../prisma/prisma.service';
import type { LineWebhookEvent } from '../dto/line';

/**
 * Durable claim of a LINE webhook event (`processedLineWebhookEvent`): the
 * lease, its renewal, the final status and the recovery sweep. Used through
 * LineWebhookService, which owns the Prisma client.
 */

/**
 * Claims a webhook event for processing by inserting its id under a
 * unique constraint. Returns false when the event was already claimed,
 * so a duplicate delivery is skipped and never replied to twice.
 */
export async function claimWebhookEvent(
  prisma: PrismaService,
  event: LineWebhookEvent,
): Promise<string | null> {
  const owner = randomUUID();
  const now = new Date();
  try {
    await prisma.processedLineWebhookEvent.create({
      data: {
        webhookEventId: event.webhookEventId,
        event: event as unknown as Prisma.InputJsonValue,
        status: 'RETRY',
        leaseUntil: now,
      },
    });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    )
      throw error;
  }
  const claimed = await prisma.processedLineWebhookEvent.updateMany({
    where: {
      webhookEventId: event.webhookEventId,
      status: { in: ['RETRY', 'PROCESSING'] },
      leaseUntil: { lte: now },
      attempts: { lt: 5 },
    },
    data: {
      status: 'PROCESSING',
      leaseOwner: owner,
      leaseUntil: new Date(Date.now() + 120_000),
      attempts: { increment: 1 },
    },
  });
  return claimed.count ? owner : null;
}

export async function renewWebhookLease(
  prisma: PrismaService,
  webhookEventId: string,
  owner: string,
) {
  await prisma.processedLineWebhookEvent.updateMany({
    where: { webhookEventId, leaseOwner: owner, status: 'PROCESSING' },
    data: { leaseUntil: new Date(Date.now() + 120_000) },
  });
}

export async function finishWebhookEvent(
  prisma: PrismaService,
  webhookEventId: string,
  owner: string,
  error?: unknown,
) {
  await prisma.processedLineWebhookEvent.updateMany({
    where: { webhookEventId, leaseOwner: owner, status: 'PROCESSING' },
    data: {
      status: error ? 'RETRY' : 'COMPLETED',
      leaseOwner: null,
      leaseUntil: new Date(Date.now() + 10_000),
      lastError: error ? String(error).slice(0, 1000) : null,
    },
  });
}

export async function recoverableWebhookEvents(
  prisma: PrismaService,
): Promise<LineWebhookEvent[]> {
  const now = new Date();
  await prisma.processedLineWebhookEvent.updateMany({
    where: {
      status: { in: ['PROCESSING', 'RETRY'] },
      attempts: { gte: 5 },
      leaseUntil: { lte: now },
    },
    data: { status: 'FAILED', leaseOwner: null },
  });
  const rows = await prisma.processedLineWebhookEvent.findMany({
    where: {
      status: { in: ['PROCESSING', 'RETRY'] },
      attempts: { lt: 5 },
      leaseUntil: { lte: now },
    },
    orderBy: { processedAt: 'asc' },
    take: 20,
  });
  return rows
    .filter((row) => row.event)
    .map((row) => row.event as unknown as LineWebhookEvent);
}
