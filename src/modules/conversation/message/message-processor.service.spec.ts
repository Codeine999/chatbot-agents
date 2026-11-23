import type { ChatbotService } from '../../chatbot/chatbot.service';
import type { LoadContextService } from '../../chatbot/context/load-context.service';
import type {
  ChannelAdapter,
  ChatTurn,
  ConversationThread,
} from '../../../shared/contracts/channel-adapter';
import type { ChatResponse } from '../../../shared/contracts/chat.types';
import { MessageProcessorService } from './message-processor.service';
import type { PipelineSwitchService } from './pipeline-switch.service';

const REPLY: ChatResponse = {
  text: 'ตารางรอบรถ',
  source: 'KNOWLEDGE',
  contextPolicy: 'INCLUDE',
};

function build(thread: ConversationThread) {
  const handleTextMessage = jest.fn(() => Promise.resolve(REPLY));
  const handleStickerMessage = jest.fn(() => Promise.resolve(REPLY));
  const turn: ChatTurn = {
    kind: 'text',
    contextUserText: 'ครับ',
    request: { userId: 'U1', text: 'ครับ', conversationId: 'c1' },
  };
  const adapter = {
    findDelivery: jest.fn(() => Promise.resolve(null)),
    saveIncomingEvent: jest.fn(() => Promise.resolve(thread)),
    toChatTurn: jest.fn(() => Promise.resolve(turn)),
    saveReply: jest.fn(() => Promise.resolve(null)),
    deliver: jest.fn(() => Promise.resolve()),
  } as unknown as ChannelAdapter<unknown, ConversationThread>;

  const service = new MessageProcessorService(
    { handleTextMessage, handleStickerMessage } as unknown as ChatbotService,
    {
      load: jest.fn(() => Promise.resolve([])),
      clear: jest.fn(() => Promise.resolve()),
    } as unknown as LoadContextService,
    {
      record: (
        _turn: unknown,
        _thread: unknown,
        work: (outcome: object) => Promise<void>,
      ) => work({}),
      replied: jest.fn(),
    },
    {
      isPaused: () => Promise.resolve(false),
    } as unknown as PipelineSwitchService,
  );

  return { service, adapter, handleTextMessage, handleStickerMessage, turn };
}

describe('MessageProcessorService handoffPending', () => {
  it.each([true, false])(
    'passes a room with handoffPending=%s to the chatbot for a text turn',
    async (handoffPending) => {
      const { service, adapter, handleTextMessage } = build({
        conversationId: 'c1',
        handoffPending,
      });

      await service.process({}, adapter);

      expect(handleTextMessage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', handoffPending }),
      );
    },
  );

  it('passes undefined when the channel did not say', async () => {
    const { service, adapter, handleTextMessage } = build({
      conversationId: 'c1',
    });

    await service.process({}, adapter);

    const request = (handleTextMessage.mock.calls[0] as unknown[])[0];
    expect((request as { handoffPending?: boolean }).handoffPending).toBe(
      undefined,
    );
  });
});
