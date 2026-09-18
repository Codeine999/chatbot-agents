import { LineDeliveryService } from './line-delivery.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LineService } from './line-reply.service';
import { LineAdminService } from './admin/line-admin.service';
import { LoadContextService } from '../chatbot/context/load-context.service';
import { UserSessionService } from '../chatbot/user-session.service';

describe('delivery control gate', () => {
  function setup(adminMemberId: string | null = 'admin') {
    const events: string[] = [];
    const row = {
      id: 'delivery',
      status: 'PENDING',
      method: 'PUSH',
      adminMemberId,
      lineUserId: 'user',
      text: 'reply',
      retryKey: 'retry',
      attempts: 1,
    };
    const prisma = {
      lineDelivery: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const mute = jest.fn(() => {
      events.push('mute');
      return Promise.resolve();
    });
    const isMuted = jest.fn().mockResolvedValue(false);
    const pushText = jest.fn(() => {
      events.push('push');
      return Promise.reject(new Error('mock unavailable'));
    });
    const service = new LineDeliveryService(
      prisma as unknown as PrismaService,
      {} as LineService,
      { pushText } as unknown as LineAdminService,
      {} as LoadContextService,
      { mute, isMuted } as unknown as UserSessionService,
    );
    return { service, events, mute, isMuted, pushText, prisma, row };
  }

  it('mutes before admin push and refreshes on actual retry', async () => {
    const ctx = setup();
    await ctx.service.deliver('delivery');
    await ctx.service.deliver('delivery');
    expect(ctx.events).toEqual(['mute', 'push', 'mute', 'push']);
    expect(ctx.pushText).toHaveBeenCalledWith('user', 'reply', 'retry');
  });

  it('does not push if Redis mute fails', async () => {
    const ctx = setup();
    ctx.mute.mockRejectedValueOnce(new Error('Redis unavailable'));
    await ctx.service.deliver('delivery');
    expect(ctx.pushText).not.toHaveBeenCalled();
  });

  it('suppresses queued automatic responses during mute', async () => {
    const ctx = setup(null);
    ctx.isMuted.mockResolvedValue(true);
    await ctx.service.deliver('delivery');
    expect(ctx.pushText).not.toHaveBeenCalled();
    expect(ctx.mute).not.toHaveBeenCalled();
    expect(ctx.prisma.lineDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }) as unknown,
      }),
    );
  });

  it('automatic PUSH fallback never mutes the customer', async () => {
    const ctx = setup(null);
    await ctx.service.deliver('delivery');
    expect(ctx.pushText).toHaveBeenCalledTimes(1);
    expect(ctx.mute).not.toHaveBeenCalled();
  });
});
