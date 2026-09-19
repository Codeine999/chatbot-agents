/** Opt-in audit characterization: real PostgreSQL/pgvector, synthetic data only.
 * Known-defect tests assert observed behavior, NOT the desired contract.
 * Never instantiate AppModule, LINE clients or production model adapters here.
 */
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AnswerPatternService } from './knowledge/answer-pattern.service';
import { AnswerPatternCacheService } from './knowledge/answer-pattern-cache.service';
import { MicroKnowledgeService } from './knowledge/micro-knowledge.service';
import { SemanticSearchService } from './knowledge/semantic-search.service';
import { KnowledgeRetrievalService } from './knowledge/knowledge-retrieval.service';
import { AnswerPatternVectorRepository } from '../ai/embeding/answer-pattern-vector.repository';
import { MicroKnowledgeVectorRepository } from '../ai/embeding/micro-knowledge-vector.repository';
import { EmbeddingService } from '../ai/embeding/embedding.service';
import { UsersAiProviderService } from '../ai/users-ai-provider.service';
import { AiBudgetService } from '../usage/rate-limit/ai-budget.service';
import { AiChatService } from './aichat.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { IntentRouterService } from './intent-router.service';
import { RuleIntentService } from './rule-intent.service';
import { AdminAiSettingService } from '../admin/ai-setting/admin-ai-setting.service';
import { CreateAdminAiSettingDto } from '../admin/ai-setting/dto/admin-ai-setting.dto';
import { AdminKnowledgeMicroService } from '../admin/knowledge/admin-knowledge-micro.service';
import { CreateAdminMicroKnowledgeDto } from '../admin/knowledge/dto/admin-micro-knowledge.dto';
import type { AuthenticatedAdmin } from '../../shared/guards/admin-auth.types';
import type {
  AiGenerateRequest,
  AiGenerateResponse,
} from '../../ai-provider/types/ai-provider.types';
import { DEFAULT_SYSTEM_PROMPT } from './constants/ai-chat.constants';
import { CreditService } from '../usage/credit-point/credit.service';
import { AiBillingService } from '../usage/billing/ai-billing.service';
import { AiPricingService } from '../usage/billing/ai-pricing.service';
import { CompanyService } from '../admin/company/company.service';
import { Prisma } from '../../generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { AdminKnowledgePatternService } from '../admin/knowledge/admin-knowledge-pattern.service';
import { ChatbotService } from './chatbot.service';
import { UserSessionService } from './user-session.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { ReplyTemplateService } from './reply-template.service';
import { StickerIntentService } from './sticker-intent.service';
import { LineWebhookService } from '../line/line-webhook.service';
import { LineDeliveryService } from '../line/line-delivery.service';
import { LineService } from '../line/line-reply.service';
import { LineAdminService } from '../line/admin/line-admin.service';
import { LoadContextService } from './context/load-context.service';
import { AiProviderSettingsService } from '../ai/ai-provider-settings.service';
import { AiProviderService } from '../ai/ai-provider.service';
import type { LineMessageEvent } from '../line/dto/line';

const sandboxUrl = process.env.CORE_AUDIT_DATABASE_URL;
const sandbox = sandboxUrl ? describe : describe.skip;
const basis = (axis: number) =>
  Array.from({ length: 1536 }, (_, i) => Number(i === axis));
const embedding = (axis = 0) => ({
  values: basis(axis),
  model: 'audit-synthetic-1536',
});
const answer = (text: string): AiGenerateResponse => ({
  text,
  provider: 'GEMINI',
  model: 'audit-mock',
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  },
});
const actor = {
  id: '00000000-0000-4000-8000-000000000001',
  role: 'admin',
  username: 'audit',
  firstName: 'audit',
  lastName: 'fixture',
  email: 'audit@example.invalid',
  phone: '',
  image: null,
} as AuthenticatedAdmin;

sandbox(
  'core audit sandbox (observed behavior, not a release acceptance suite)',
  () => {
    let db: PrismaService;
    const config = new ConfigService({
      AI_SETTING_TENANT_ID: '',
      KNOWLEDGE_TENANT_ID: '',
      KNOWLEDGE_LANGUAGE: 'th',
    });
    let cache: AnswerPatternCacheService;
    let matcher: AnswerPatternService;
    let vectors: AnswerPatternVectorRepository;
    let microVectors: MicroKnowledgeVectorRepository;
    let retrieval: KnowledgeRetrievalService;
    const embedQuery = jest
      .fn()
      .mockImplementation(() => Promise.resolve(embedding()));
    const embedDocument = jest
      .fn()
      .mockImplementation(() => Promise.resolve(embedding()));
    const generate = jest.fn<
      Promise<AiGenerateResponse>,
      [AiGenerateRequest, unknown?]
    >();
    const provider = { generate } as unknown as UsersAiProviderService;
    const budget = {
      tryConsume: jest.fn().mockResolvedValue(true),
    } as unknown as AiBudgetService;
    let ai: AiChatService;
    let router: IntentRouterService;
    let microAdmin: AdminKnowledgeMicroService;

    beforeAll(async () => {
      const url = new URL(sandboxUrl!);
      if (
        url.hostname !== '127.0.0.1' ||
        url.pathname !== '/core_audit' ||
        url.username !== 'audit' ||
        url.port === '5432'
      ) {
        throw new Error(
          'Refusing database other than the dedicated ephemeral core_audit sandbox',
        );
      }
      Logger.overrideLogger(false);
      db = new PrismaService(new ConfigService({ DATABASE_URL: sandboxUrl }));
      await db.$connect();
      matcher = new AnswerPatternService(db, config);
      cache = new AnswerPatternCacheService(db, config);
      vectors = new AnswerPatternVectorRepository(db);
      microVectors = new MicroKnowledgeVectorRepository(db);
      const embed = {
        embedQuery,
        embedDocument,
      } as unknown as EmbeddingService;
      retrieval = new KnowledgeRetrievalService(
        matcher,
        cache,
        new SemanticSearchService(embed, vectors, microVectors, config),
        new MicroKnowledgeService(db, matcher, config),
        config,
      );
      ai = new AiChatService(db, retrieval, budget, provider, config);
      router = new IntentRouterService(
        new RuleIntentService(),
        retrieval,
        new AiIntentClassifierService(budget, provider),
      );
      microAdmin = new AdminKnowledgeMicroService(
        db,
        embed,
        microVectors,
        config,
      );
    });
    beforeEach(async () => {
      await db.answerPattern.deleteMany();
      await db.microKnowledge.deleteMany();
      await db.aiSetting.deleteMany();
      await cache.refresh();
      embedQuery.mockClear();
      embedDocument
        .mockReset()
        .mockImplementation(() => Promise.resolve(embedding()));
      generate
        .mockReset()
        .mockRejectedValue(new Error('Unexpected model call'));
    });
    afterAll(async () => {
      if (db) await db.$disconnect();
    });

    it('migrated AiSetting defaults are structured JSON and nullable tenant', async () => {
      const row = await db.aiSetting.create({
        data: { systemPrompt: 'กฎทดสอบ' },
      });
      expect(row).toMatchObject({
        tenantId: null,
        skills: [],
        responseStyle: { targetLength: 'adaptive', emojiLevel: 'light' },
        promptVersion: 1,
        active: true,
      });
    });

    it('exact Thai question returns curated text without embedding or generation', async () => {
      await db.answerPattern.create({
        data: {
          title: 'การดูแลหมอน Cloud',
          questionExamples: ['หมอน Cloud ซักได้ไหม'],
          answer: 'ถอดปลอกซักได้ครับ แต่ไส้หมอนห้ามซักนะครับ',
        },
      });
      const result = await ai.answerKnowledge('หมอน Cloud ซักได้ไหม');
      expect(result).toEqual({
        text: 'ถอดปลอกซักได้ครับ แต่ไส้หมอนห้ามซักนะครับ',
        isFallback: false,
      });
      expect(embedQuery).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    });

    it('observes substring collision: general sleep question enters business RAG', async () => {
      await db.answerPattern.create({
        data: {
          title: 'หมอน',
          keywords: ['หมอน'],
          answer: 'หมอน Cloud มีปลอกถอดซักได้',
        },
      });
      const result = await retrieval.retrieve('นอนไม่หลับควรไปหาหมอนไหม');
      expect(result.route).toBe('RAG');
      expect(result.selectedItems[0].metadata?.rawScore).toBe(4);
      expect(result.topScores[0]).toBeCloseTo(1 / 61);
    });

    it('real pgvector excludes other tenant, inactive, language and model rows', async () => {
      for (const [i, fields] of [
        {},
        { tenantId: '00000000-0000-4000-8000-000000000099' },
        { active: false },
        { language: 'en' },
      ].entries()) {
        const row = await db.microKnowledge.create({
          data: { title: `fact-${i}`, answer: 'ข้อมูลสังเคราะห์', ...fields },
        });
        await microVectors.upsert(
          db,
          row.id,
          basis(0),
          embedding().model,
          true,
        );
      }
      const rows = await microVectors.search(basis(0), embedding().model, 20, {
        tenantId: null,
        language: 'th',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].score).toBeCloseTo(1);
      expect(
        await microVectors.search(basis(0), 'different-model', 20, {
          tenantId: null,
          language: 'th',
        }),
      ).toEqual([]);
    });

    it('vector-only RAG uses one query embedding and one answer call', async () => {
      const fact = await db.microKnowledge.create({
        data: {
          title: 'การดูแล Cloud',
          answer: 'ไส้หมอนห้ามซัก',
          entityKey: 'cloud',
          topicKey: 'care',
        },
      });
      await microVectors.upsert(db, fact.id, basis(0), embedding().model, true);
      generate.mockResolvedValueOnce(
        answer('ไส้หมอนซักไม่ได้ครับ แนะนำซักเฉพาะปลอกนะครับ'),
      );
      const result = await ai.answerKnowledge('เอา Cloud ลงเครื่องทั้งใบได้ปะ');
      expect(result.isFallback).toBe(false);
      expect(embedQuery).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate.mock.calls[0][0].systemInstruction).toContain(
        'ไส้หมอนห้ามซัก',
      );
    });

    it('GENERAL low-confidence routing accepts even classifier confidence zero', async () => {
      generate.mockResolvedValueOnce(
        answer('{"classification":"GENERAL","confidence":0}'),
      );
      const decision = await router.resolve({
        userId: 'audit',
        input: 'ทำไมท้องฟ้าสีฟ้า',
        session: undefined,
      });
      expect(decision.action).toBe('GENERAL_QUESTION');
      generate.mockResolvedValueOnce(
        answer('แสงสีฟ้ากระเจิงในอากาศได้มากกว่า จึงเห็นท้องฟ้าเป็นสีฟ้าครับ'),
      );
      await ai.answerGeneral('ทำไมท้องฟ้าสีฟ้า');
      expect(embedQuery).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(2);
    });

    it('BUSINESS miss and malformed classifier both hand off', async () => {
      for (const text of [
        '{"classification":"BUSINESS","confidence":0.9}',
        'not-json',
      ]) {
        generate.mockResolvedValueOnce(answer(text));
        expect(
          (
            await router.resolve({
              userId: 'audit',
              input: 'ร้านรับสลักชื่อไหม',
              session: undefined,
            })
          ).action,
        ).toBe('CONTACT_ADMIN');
      }
    });

    it('greeting skips retrieval and reaches one generation', async () => {
      const decision = await router.resolve({
        userId: 'audit',
        input: 'สวัสดีครับ',
        session: undefined,
      });
      expect(decision.action).toBe('CONTINUE_AI_CHAT');
      generate.mockResolvedValueOnce(
        answer('สวัสดีครับ วันนี้ให้ช่วยเรื่องไหนครับ'),
      );
      await ai.answerGeneral('สวัสดีครับ');
      expect(embedQuery).not.toHaveBeenCalled();
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it('observes cache snapshot serving an answer disabled by another instance', async () => {
      const row = await db.answerPattern.create({
        data: {
          title: 'care',
          questionExamples: ['หมอนซักอย่างไร'],
          answer: 'คำตอบเก่าที่ถอนแล้ว',
        },
      });
      await cache.refresh();
      await db.answerPattern.update({
        where: { id: row.id },
        data: { active: false },
      });
      expect((await ai.answerKnowledge('หมอนซักอย่างไร')).text).toBe(
        'คำตอบเก่าที่ถอนแล้ว',
      );
    });

    it('observes ADMIN create replacing DEV platform prompt in active selection', async () => {
      const service = new AdminAiSettingService(db, config);
      await db.aiSetting.create({
        data: {
          systemPrompt: 'DEV_ONLY_RULE',
          updatedAt: new Date('2020-01-01'),
        },
      });
      await service.create(
        CreateAdminAiSettingDto.schema.parse({ ownerPrompt: 'แอดมินร้านหมอน' }),
        actor,
      );
      generate.mockResolvedValueOnce(answer('สวัสดีครับ'));
      await ai.answerGeneral('สวัสดี');
      expect(generate.mock.calls[0][0].systemInstruction).not.toContain(
        'DEV_ONLY_RULE',
      );
      expect(generate.mock.calls[0][0].systemInstruction).toContain(
        DEFAULT_SYSTEM_PROMPT,
      );
    });

    it('observes current message duplicated in platform prompt and user role', async () => {
      generate.mockResolvedValueOnce(answer('สวัสดีครับ'));
      await ai.answerGeneral('audit-unique-current');
      const request = generate.mock.calls[0][0];
      expect(request.systemInstruction).toContain('audit-unique-current');
      expect(request.messages.at(-1)?.text).toBe('audit-unique-current');
    });

    it('observes answer-pattern admin list and delete crossing tenant scope', async () => {
      const row = await db.answerPattern.create({
        data: {
          tenantId: '00000000-0000-4000-8000-000000000099',
          title: 'foreign',
          answer: 'foreign synthetic content',
        },
      });
      const service = new AdminKnowledgePatternService(
        db,
        { embedDocument } as unknown as EmbeddingService,
        cache,
        vectors,
      );
      expect((await service.list()).map((item) => item.id)).toContain(row.id);
      await service.remove(row.id);
      expect(
        await db.answerPattern.findUnique({ where: { id: row.id } }),
      ).toBeNull();
    });

    it('observes provider-error fallback promising handoff without requesting admin', async () => {
      await db.aiSetting.create({
        data: {
          systemPrompt: 'กฎทดสอบ',
          fallbackMessage: 'ส่งต่อแอดมินช่วยตรวจสอบให้ครับ',
        },
      });
      const row = await db.microKnowledge.create({
        data: { title: 'Cloud', answer: 'ซักเฉพาะปลอก' },
      });
      await microVectors.upsert(db, row.id, basis(0), embedding().model, true);
      const requestAdmin = jest.fn();
      const sessions = {
        isMuted: () => Promise.resolve(false),
        get: () => Promise.resolve(undefined),
        requestAdmin,
      } as unknown as UserSessionService;
      const chatbot = new ChatbotService(
        router,
        sessions,
        {} as RegistrationFlowService,
        new ReplyTemplateService(),
        ai,
        new StickerIntentService(),
        config,
      );
      generate.mockRejectedValueOnce(new Error('synthetic provider timeout'));
      const reply = await chatbot.handleTextMessage({
        userId: 'audit',
        text: 'เอา Cloud ลงเครื่องทั้งใบได้ปะ',
      });
      expect(reply.text).toBe('ส่งต่อแอดมินช่วยตรวจสอบให้ครับ');
      expect(requestAdmin).not.toHaveBeenCalled();
    });

    it('admin micro create atomically stores document and searchable vector', async () => {
      const row = await microAdmin.create(
        CreateAdminMicroKnowledgeDto.schema.parse({
          title: 'ปลอก Cloud',
          answer: 'ปลอกถอดซักได้',
          entityKey: 'cloud',
          topicKey: 'cover',
        }),
      );
      const rows = await microVectors.search(basis(0), embedding().model, 20, {
        tenantId: null,
        language: 'th',
      });
      expect(rows[0].id).toBe(row.id);
      expect(embedDocument).toHaveBeenCalledTimes(1);
    });

    it('observes reindex race overwriting a newer document vector', async () => {
      const row = await microAdmin.create(
        CreateAdminMicroKnowledgeDto.schema.parse({
          title: 'ปลอก Cloud',
          answer: 'คำตอบเก่า',
        }),
      );
      let release!: (value: ReturnType<typeof embedding>) => void;
      let started!: () => void;
      const hasStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      embedDocument.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const indexing = microAdmin.reindex();
      await hasStarted;
      await db.$transaction(async (tx) => {
        await tx.microKnowledge.update({
          where: { id: row.id },
          data: { answer: 'คำตอบใหม่' },
        });
        await microVectors.upsert(
          tx,
          row.id,
          basis(1),
          embedding().model,
          true,
        );
      });
      release(embedding(0));
      await indexing;
      const rows = await microVectors.search(basis(0), embedding().model, 20, {
        tenantId: null,
        language: 'th',
      });
      expect(rows[0].answer).toBe('คำตอบใหม่');
      expect(rows[0].score).toBeCloseTo(1); // stale old-document vector now ranks the new answer
    });

    it('webhook service to billed greeting to accepted delivery survives replay', async () => {
      const ctx = await billingFixture();
      // This path uses the application's full output-token allowance.
      await db.$transaction(async (tx) => {
        await tx.creditWallet.update({
          where: { id: ctx.wallet.id },
          data: {
            balanceCredit: { increment: '99000' },
            lifetimeTopupCredit: { increment: '99000' },
          },
        });
        await tx.creditLedger.create({
          data: {
            walletId: ctx.wallet.id,
            type: 'TOPUP',
            amountCredit: '99000',
            balanceAfterCredit: '100000',
            idempotencyKey: `audit-extra:${ctx.wallet.id}`,
          },
        });
      });
      const adapterCall = jest.fn().mockResolvedValue(ctx.result);
      const billedProvider = new UsersAiProviderService(
        {
          get: () => Promise.resolve({ provider: 'GEMINI', model: ctx.model }),
        } as unknown as AiProviderSettingsService,
        { generateWith: adapterCall } as unknown as AiProviderService,
        ctx.billing,
      );
      const scopedAi = new AiChatService(
        db,
        retrieval,
        budget,
        billedProvider,
        config,
      );
      const sessions = {
        isMuted: () => Promise.resolve(false),
        get: () => Promise.resolve(undefined),
      } as unknown as UserSessionService;
      const chatbot = new ChatbotService(
        router,
        sessions,
        {} as RegistrationFlowService,
        new ReplyTemplateService(),
        scopedAi,
        new StickerIntentService(),
        config,
      );
      const replyText = jest.fn().mockResolvedValue(true);
      const pushText = jest
        .fn()
        .mockRejectedValue(new Error('Unexpected push'));
      const line = { replyText } as unknown as LineService;
      const lineAdmin = { pushText } as unknown as LineAdminService;
      const context = {
        load: () => Promise.resolve([]),
        appendTurn: jest.fn().mockResolvedValue(true),
        clear: jest.fn().mockResolvedValue(true),
      } as unknown as LoadContextService;
      const delivery = new LineDeliveryService(
        db,
        line,
        lineAdmin,
        context,
        sessions,
      );
      const webhook = new LineWebhookService(
        db,
        line,
        chatbot,
        context,
        lineAdmin,
        delivery,
        sessions,
      );
      const member = await db.lineMember.create({
        data: {
          lineUserId: `audit-${randomUUID()}`,
          displayName: 'Synthetic customer',
        },
      });
      const event: LineMessageEvent = {
        type: 'message',
        message: { type: 'text', id: randomUUID(), text: 'สวัสดีครับ' },
        webhookEventId: randomUUID(),
        deliveryContext: { isRedelivery: false },
        timestamp: Date.now(),
        source: { type: 'user', userId: member.lineUserId },
        replyToken: 'synthetic-token',
        mode: 'active',
      };
      const owner = await webhook.claimWebhookEvent(event);
      expect(owner).not.toBeNull();
      await webhook.processEvent(event, owner!);
      await webhook.finishWebhookEvent(event.webhookEventId, owner!);
      expect(await webhook.claimWebhookEvent(event)).toBeNull();
      await webhook.processEvent(event); // exercise durable existing-delivery repair
      expect(adapterCall).toHaveBeenCalledTimes(1);
      expect(replyText).toHaveBeenCalledTimes(1);
      expect(pushText).not.toHaveBeenCalled();
      const conversation = await db.lineConversation.findUniqueOrThrow({
        where: { lineMemberId: member.id },
      });
      expect(conversation.unreadCount).toBe(1);
      expect(
        await db.lineChatHistory.count({
          where: { conversationId: conversation.id },
        }),
      ).toBe(2);
      const outbound = await db.lineDelivery.findUniqueOrThrow({
        where: { key: event.webhookEventId },
      });
      expect(outbound.status).toBe('ACCEPTED');
      expect(outbound.finalizedAt).not.toBeNull();
      const usage = await db.aiUsageEvent.findFirstOrThrow({
        where: { conversationId: conversation.id },
      });
      expect(usage.lineMemberId).toBe(member.id);
      expect(usage.kind).toBe('LINE_AI_REPLY');
      expect(
        await db.creditLedger.count({
          where: { usageEventId: usage.id, type: 'DEBIT' },
        }),
      ).toBe(1);
    });

    async function billingFixture() {
      const company = await db.company.create({
        data: { name: 'Synthetic audit', companyType: 'test', image: '' },
      });
      const wallet = await db.creditWallet.create({
        data: {
          companyId: company.id,
          balanceCredit: '1000',
          lifetimeTopupCredit: '1000',
        },
      });
      await db.creditLedger.create({
        data: {
          walletId: wallet.id,
          type: 'TOPUP',
          amountCredit: '1000',
          balanceAfterCredit: '1000',
          idempotencyKey: `audit-seed:${wallet.id}`,
        },
      });
      const model = `audit-${randomUUID()}`;
      const pricing = await db.aiModelPricing.create({
        data: {
          provider: 'GEMINI',
          model,
          inputCreditPerMillTokens: '1000000',
          outputCreditPerMillTokens: '1000000',
          effectiveFrom: new Date('2020-01-01'),
        },
      });
      const credit = new CreditService(
        db,
        { getCompanyId: () => Promise.resolve(company.id) } as CompanyService,
        new ConfigService(),
      );
      const billing = new AiBillingService(credit, new AiPricingService(db));
      const result = { ...answer('คำตอบจาก mock สำหรับตรวจบัญชี'), model };
      return { wallet, model, pricing, credit, billing, result };
    }

    it('real billing replay settles once with matching wallet, budget, usage and debit', async () => {
      const ctx = await billingFixture();
      const call = jest.fn().mockResolvedValue(ctx.result);
      const params = {
        kind: 'LINE_AI_REPLY' as const,
        provider: 'GEMINI' as const,
        model: ctx.model,
        scopeKey: 'audit-reply',
        turnId: randomUUID(),
        request: {
          messages: [{ role: 'user' as const, text: 'hi' }],
          maxOutputTokens: 2,
        },
        call,
      };
      await ctx.billing.runBilled(params);
      await ctx.billing.runBilled(params);
      expect(call).toHaveBeenCalledTimes(1);
      const wallet = await db.creditWallet.findUniqueOrThrow({
        where: { id: ctx.wallet.id },
      });
      expect(wallet.balanceCredit.toString()).toBe('998');
      expect(wallet.reservedCredit.toString()).toBe('0');
      expect(wallet.lifetimeSpentCredit.toString()).toBe('2');
      const budget = await db.creditBudget.findFirstOrThrow({
        where: { walletId: wallet.id },
      });
      expect(budget.usedCredit.toString()).toBe('2');
      expect(budget.reservedCredit.toString()).toBe('0');
      const events = await db.aiUsageEvent.findMany({
        where: { companyId: wallet.companyId },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        scopeKey: 'audit-reply',
        pricingId: ctx.pricing.id,
        status: 'success',
      });
      const ledger = await db.creditLedger.findMany({
        where: { walletId: wallet.id, type: 'DEBIT' },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].amountCredit.toString()).toBe('-2');
      expect(ledger[0].balanceAfterCredit.toString()).toBe('998');
      expect(ledger[0].usageEventId).toBe(events[0].id);
      expect(
        await db.creditReservation.count({
          where: { walletId: wallet.id, status: 'SETTLED' },
        }),
      ).toBe(1);
    });

    it('real provider failure releases reservation without debit', async () => {
      const ctx = await billingFixture();
      await expect(
        ctx.billing.runBilled({
          kind: 'LINE_AI_REPLY',
          provider: 'GEMINI',
          model: ctx.model,
          scopeKey: 'audit-failure',
          turnId: randomUUID(),
          request: {
            messages: [{ role: 'user', text: 'hi' }],
            maxOutputTokens: 2,
          },
          call: () => Promise.reject(new Error('synthetic provider failure')),
        }),
      ).rejects.toThrow('synthetic provider failure');
      const wallet = await db.creditWallet.findUniqueOrThrow({
        where: { id: ctx.wallet.id },
      });
      expect(wallet.balanceCredit.toString()).toBe('1000');
      expect(wallet.reservedCredit.toString()).toBe('0');
      expect(wallet.lifetimeSpentCredit.toString()).toBe('0');
      expect(
        await db.creditLedger.count({
          where: { walletId: wallet.id, type: 'DEBIT' },
        }),
      ).toBe(0);
      expect(
        await db.creditReservation.count({
          where: { walletId: wallet.id, status: 'RELEASED' },
        }),
      ).toBe(1);
      const event = await db.aiUsageEvent.findFirstOrThrow({
        where: { companyId: wallet.companyId },
      });
      expect(event.status).toBe('failed');
      expect(event.chargedCredit.toString()).toBe('0');
    });

    it('concurrent same-operation reservations hold credit only once', async () => {
      const ctx = await billingFixture();
      const operationKey = randomUUID();
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          ctx.credit.reserveAiCredit(
            'LINE_AI_REPLY',
            'audit-concurrency',
            new Prisma.Decimal('5'),
            { operationKey },
          ),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        await db.creditReservation.count({
          where: { operationKey, status: 'HELD' },
        }),
      ).toBe(1);
      const held = results.find((result) => result.status === 'fulfilled');
      if (held?.status !== 'fulfilled')
        throw new Error('Expected one reservation');
      await ctx.credit.releaseAiCredit(held.value);
      await ctx.credit.releaseAiCredit(held.value);
      const wallet = await db.creditWallet.findUniqueOrThrow({
        where: { id: ctx.wallet.id },
      });
      expect(wallet.reservedCredit.toString()).toBe('0');
      expect(wallet.balanceCredit.toString()).toBe('1000');
    });
  },
);
