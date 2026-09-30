import { PrismaService } from '../../prisma/prisma.service';
import { ChatbotService } from '../chatbot/chatbot.service';
import { LoadContextService } from '../chatbot/context/load-context.service';
import { RichMenuReplyCacheService } from '../chatbot/menu/rich-menu-reply-cache.service';
import { UserSessionService } from '../chatbot/user-session.service';
import { LineAdminService } from './admin/line-admin.service';
import { LineDeliveryService } from './line-delivery.service';
import { LineService } from './line-reply.service';
import { LineWebhookService } from './line-webhook.service';

describe('LINE conversation list', () => {
  it('puts waiting_admin rooms first, newest first within each status group', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'open-new', status: 'open' },
      { id: 'waiting-new', status: 'waiting_admin' },
      { id: 'open-old', status: 'open' },
      { id: 'waiting-old', status: 'waiting_admin' },
    ]);
    const service = new LineWebhookService(
      { lineConversation: { findMany } } as unknown as PrismaService,
      {} as LineService,
      {} as ChatbotService,
      {} as LoadContextService,
      {} as LineAdminService,
      {} as LineDeliveryService,
      {} as UserSessionService,
      {} as RichMenuReplyCacheService,
    );

    const result = await service.listConversations();

    expect(result.map((conversation) => conversation.id)).toEqual([
      'waiting-new',
      'waiting-old',
      'open-new',
      'open-old',
    ]);
    expect(findMany).toHaveBeenCalledWith({
      orderBy: [
        { lastMessageAt: 'desc' },
        { updatedAt: 'desc' },
        { id: 'desc' },
      ],
      include: { lineMember: true },
    });
  });
});
