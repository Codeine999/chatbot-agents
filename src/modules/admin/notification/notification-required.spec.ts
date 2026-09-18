import { NotificationService } from './notification.service';
import { NotificationGateway } from './notification.gateway';
import { PrismaService } from '../../../prisma/prisma.service';

describe('admin required notification', () => {
  it('persists and emits the requested title with the conversation link', async () => {
    const conversationId = '00000000-0000-4000-8000-000000000001';
    const create = jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...data,
          id: 'notice',
          isRead: false,
        }),
      );
    const emitAdminNotification = jest.fn();
    const service = new NotificationService(
      {
        lineConversation: {
          findFirst: jest.fn().mockResolvedValue({
            id: conversationId,
            lastMessage: 'fixture',
            lineMember: { displayName: 'Test', pictureUrl: null },
          }),
        },
        adminNotification: { create },
      } as unknown as PrismaService,
      { emitAdminNotification } as unknown as NotificationGateway,
    );
    await service.notifyAdminRequired({
      userId: 'user',
      flow: 'REGISTER',
      step: 'SEND_REGISTER_FORM',
      status: 'ACTIVE',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(emitAdminNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CONTACT_ADMIN',
        title: 'มีลูกค้าต้องการคำตอบจากแอดมินในขณะนี้',
        message: 'Test กำลังรอคำตอบจากแอดมิน',
        metadata: {
          conversationId,
          displayName: 'Test',
          pictureUrl: null,
          lastMessage: 'fixture',
          flow: 'REGISTER',
          step: 'SEND_REGISTER_FORM',
          status: 'ACTIVE',
        },
      }),
    );
  });
});
