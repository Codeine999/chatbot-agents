import { LineWebhookService } from './line-webhook.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatbotService } from '../chatbot/chatbot.service';
import { LoadContextService } from '../chatbot/context/load-context.service';
import { LineService } from './line-reply.service';
import { LineAdminService } from './admin/line-admin.service';
import { LineDeliveryService } from './line-delivery.service';
import { UserSessionService } from '../chatbot/user-session.service';
import { RichMenuReplyCacheService } from '../chatbot/menu/rich-menu-reply-cache.service';

describe('admin resume endpoint service', () => {
  it('resumes the conversation user, resolves the request and preserves registration', async () => {
    const resume = jest.fn().mockResolvedValue(undefined);
    const clearWorkflow = jest.fn();
    const clearContext = jest.fn().mockResolvedValue(undefined);
    const update = jest.fn().mockResolvedValue({});
    const service = new LineWebhookService(
      {
        lineConversation: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ lineMember: { lineUserId: 'user' } }),
          update,
        },
      } as unknown as PrismaService,
      {} as LineService,
      {} as ChatbotService,
      { clear: clearContext } as unknown as LoadContextService,
      {} as LineAdminService,
      {} as LineDeliveryService,
      { resume, clear: clearWorkflow } as unknown as UserSessionService,
      // This test never reaches a postback, so no menu lookup is configured.
      { byPostbackData: () => null } as unknown as RichMenuReplyCacheService,
    );
    expect(await service.resumeBot('conversation')).toEqual({ status: 'open' });
    expect(resume).toHaveBeenCalledWith('user');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'conversation' },
      data: { status: 'open' },
    });
    expect(clearContext).toHaveBeenCalledWith('conversation');
    expect(clearWorkflow).not.toHaveBeenCalled();
  });
});
