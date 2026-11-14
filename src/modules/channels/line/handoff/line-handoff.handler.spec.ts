import { ChannelHandoffRegistry } from '../../../session/channel-handoff.registry';
import { LineHandoffHandler } from './line-handoff.handler';

function build(updated: number, waiting: number) {
  const prisma = {
    lineConversation: {
      updateMany: jest.fn().mockResolvedValue({ count: updated }),
      count: jest.fn().mockResolvedValue(waiting),
    },
  };
  const notifications = {
    notifyAdminRequired: jest.fn().mockResolvedValue(undefined),
  };
  const sessions = { get: jest.fn().mockResolvedValue(undefined) };
  const registry = new ChannelHandoffRegistry();
  const handler = new LineHandoffHandler(
    registry,
    prisma as never,
    notifications as never,
    sessions as never,
  );
  return { handler, registry, prisma, notifications };
}

describe('LineHandoffHandler.requestAdmin', () => {
  it('REQUESTED and notifies once on the transition', async () => {
    const { handler, notifications, prisma } = build(1, 0);
    await expect(handler.requestAdmin('U1')).resolves.toBe('REQUESTED');
    expect(notifications.notifyAdminRequired).toHaveBeenCalledWith({
      userId: 'U1',
      flow: 'CONTACT_ADMIN',
      step: 'WAITING_ADMIN',
      status: 'ACTIVE',
    });
    expect(prisma.lineConversation.updateMany).toHaveBeenCalledWith({
      where: {
        lineMember: { lineUserId: 'U1' },
        status: { not: 'waiting_admin' },
      },
      data: { status: 'waiting_admin' },
    });
  });

  it('ALREADY_WAITING does not notify again', async () => {
    const { handler, notifications } = build(0, 1);
    await expect(handler.requestAdmin('U1')).resolves.toBe('ALREADY_WAITING');
    expect(notifications.notifyAdminRequired).not.toHaveBeenCalled();
  });

  it('NO_ROOM when the user has no conversation', async () => {
    const { handler } = build(0, 0);
    await expect(handler.requestAdmin('U1')).resolves.toBe('NO_ROOM');
  });

  it('still REQUESTED when the notification throws', async () => {
    const { handler, notifications } = build(1, 0);
    notifications.notifyAdminRequired.mockRejectedValue(new Error('x'));
    await expect(handler.requestAdmin('U1')).resolves.toBe('REQUESTED');
  });

  it('registers itself as the handler of unprefixed (LINE) user ids', () => {
    const { handler, registry } = build(1, 0);
    handler.onModuleInit();
    expect(registry.find('Uf3c')).toBe(handler);
  });
});
