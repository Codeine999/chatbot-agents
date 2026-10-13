/**
 * An unfunded AI wallet: billing refuses the reservation before any provider
 * call. The LINE chat sends no reply, requests no admin, and logs the reason.
 * Every other AI failure keeps its existing safe fallback.
 */
import { Logger } from '@nestjs/common';
import { buildHarness, pattern } from './audit/core-chat.harness';
import { InsufficientCreditException } from '../usage/credit-point/insufficient-credit.exception';

const NO_REPLY = { text: '', source: 'SYSTEM', contextPolicy: 'EXCLUDE' };
const unfunded = () =>
  new InsufficientCreditException(
    'Insufficient AI credit: reserving 0.4 from 0 available would leave -0.4 <= 20 minimum',
  );
const ask = (text: string) => ({
  userId: 'U1',
  text,
  conversationId: 'c1',
  turnId: 't1',
});

describe('ChatbotService with an unfunded AI wallet', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => logError.mockRestore());

  const loggedCredit = () =>
    logError.mock.calls.some(
      ([message]) =>
        typeof message === 'string' &&
        message.includes('no reply sent: AI credit is insufficient') &&
        message.includes('<= 20 minimum') &&
        message.includes('turn=t1'),
    );

  it('sends nothing when the query embedding cannot be reserved', async () => {
    const harness = buildHarness();
    harness.spies.embedQuery.mockRejectedValueOnce(unfunded());

    const response = await harness.chatbot.handleTextMessage(ask('สวัสดี'));

    expect(response).toEqual(NO_REPLY);
    expect(harness.spies.generate).not.toHaveBeenCalled();
    expect(harness.spies.conversationUpdateMany).not.toHaveBeenCalled();
    expect(harness.spies.notifyAdminRequired).not.toHaveBeenCalled();
    expect(loggedCredit()).toBe(true);
  });

  it('sends nothing when a grounded answer cannot be reserved', async () => {
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'shipping',
          title: 'ค่าส่ง',
          keywords: ['ค่าส่ง'],
          questionExamples: ['ค่าส่งเท่าไหร่'],
          answer: 'ค่าส่ง 50 บาท',
          renderMode: 'REWRITE',
        }),
      ],
    });
    harness.spies.generate.mockRejectedValueOnce(unfunded());

    const response = await harness.chatbot.handleTextMessage(
      ask('ค่าส่งเท่าไหร่'),
    );

    expect(response).toEqual(NO_REPLY);
    expect(harness.spies.generate).toHaveBeenCalledTimes(1);
    expect(harness.spies.conversationUpdateMany).not.toHaveBeenCalled();
    expect(loggedCredit()).toBe(true);
  });

  it('sends nothing when general chat cannot be reserved', async () => {
    const harness = buildHarness();
    harness.spies.generate.mockRejectedValueOnce(unfunded());

    const response = await harness.chatbot.handleTextMessage(
      ask('ขอสอบถามหน่อยค่ะ'),
    );

    expect(response).toEqual(NO_REPLY);
    expect(harness.spies.conversationUpdateMany).not.toHaveBeenCalled();
  });

  it('sends nothing when an image answer cannot be reserved', async () => {
    const harness = buildHarness();
    harness.spies.generate.mockRejectedValueOnce(unfunded());

    const response = await harness.chatbot.handleImageMessage({
      userId: 'U1',
      conversationId: 'c1',
      turnId: 't1',
      image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    });

    expect(response).toEqual(NO_REPLY);
    expect(harness.spies.conversationUpdateMany).not.toHaveBeenCalled();
    expect(loggedCredit()).toBe(true);
  });

  it('keeps the safe fallback and handoff for other retrieval failures', async () => {
    const harness = buildHarness();
    harness.spies.embedQuery.mockRejectedValueOnce(new Error('timeout'));

    const response = await harness.chatbot.handleTextMessage(ask('สวัสดี'));

    expect(response.text).not.toBe('');
    expect(response.contextPolicy).toBe('CLEAR');
    expect(harness.spies.conversationUpdateMany).toHaveBeenCalledTimes(1);
    expect(loggedCredit()).toBe(false);
  });
});
