import type { ChannelHandoffHandler } from '../../session/channel-handoff.registry';
import { ChannelStoreHandoff } from './channel-handoff.handler';

const CONTACT = '11111111-1111-4111-8111-111111111111';

function build(updated: number, waiting: number, conversation = true) {
  const prisma = {
    channelConversation: {
      updateMany: jest.fn().mockResolvedValue({ count: updated }),
      count: jest.fn().mockResolvedValue(waiting),
      findUnique: jest
        .fn()
        .mockResolvedValue(
          conversation
            ? { id: 'c1', lastMessage: 'hi', contact: { displayName: 'A' } }
            : null,
        ),
    },
  };
  const notifications = {
    notifyChannelAdminRequired: jest.fn().mockResolvedValue(undefined),
  };
  const registered: ChannelHandoffHandler[] = [];
  const handoff = new ChannelStoreHandoff(
    { register: (h: ChannelHandoffHandler) => registered.push(h) } as never,
    prisma as never,
    notifications as never,
    { get: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { handoff, prisma, notifications, registered };
}

describe('ChannelStoreHandoff', () => {
  it('registers one handler per stored channel prefix', () => {
    const { handoff, registered } = build(1, 0);
    handoff.onModuleInit();
    expect(registered.map((h) => h.userIdPrefix).sort()).toEqual([
      'app:',
      'fb:',
    ]);
  });

  it('routes a prefixed user id to its own channel', async () => {
    const { handoff, registered, prisma } = build(1, 0);
    handoff.onModuleInit();
    const fb = registered.find((h) => h.userIdPrefix === 'fb:')!;

    await expect(fb.requestAdmin(`fb:${CONTACT}`)).resolves.toBe('REQUESTED');
    const [args] = prisma.channelConversation.updateMany.mock
      .calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(args.where).toMatchObject({
      contactId: CONTACT,
      channel: 'FACEBOOK',
    });
  });

  it('REQUESTED and notifies when the room moves to waiting_admin', async () => {
    const { handoff, notifications } = build(1, 0);
    await expect(
      handoff.requestAdmin('APP', CONTACT, `app:${CONTACT}`),
    ).resolves.toBe('REQUESTED');
    expect(notifications.notifyChannelAdminRequired).toHaveBeenCalledTimes(1);
  });

  it('ALREADY_WAITING without notifying, scoped to the channel', async () => {
    const { handoff, notifications, prisma } = build(0, 1);
    await expect(
      handoff.requestAdmin('APP', CONTACT, `app:${CONTACT}`),
    ).resolves.toBe('ALREADY_WAITING');
    expect(notifications.notifyChannelAdminRequired).not.toHaveBeenCalled();
    expect(prisma.channelConversation.count).toHaveBeenCalledWith({
      where: { contactId: CONTACT, channel: 'APP', status: 'waiting_admin' },
    });
  });

  it('NO_ROOM when no conversation exists', async () => {
    const { handoff } = build(0, 0);
    await expect(
      handoff.requestAdmin('APP', CONTACT, `app:${CONTACT}`),
    ).resolves.toBe('NO_ROOM');
  });

  it('NO_ROOM for a malformed contact id without touching the database', async () => {
    const { handoff, prisma } = build(1, 0);
    await expect(handoff.requestAdmin('APP', 'nope', 'app:nope')).resolves.toBe(
      'NO_ROOM',
    );
    expect(prisma.channelConversation.updateMany).not.toHaveBeenCalled();
  });

  it('still REQUESTED when the admin notification fails', async () => {
    const { handoff, notifications } = build(1, 0);
    notifications.notifyChannelAdminRequired.mockRejectedValue(new Error('x'));
    await expect(
      handoff.requestAdmin('APP', CONTACT, `app:${CONTACT}`),
    ).resolves.toBe('REQUESTED');
  });

  it('still REQUESTED, with no notice, when the row vanished after the update', async () => {
    const { handoff, notifications } = build(1, 0, false);
    await expect(
      handoff.requestAdmin('APP', CONTACT, `app:${CONTACT}`),
    ).resolves.toBe('REQUESTED');
    expect(notifications.notifyChannelAdminRequired).not.toHaveBeenCalled();
  });
});
