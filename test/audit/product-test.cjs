/* Live audit harness. This file never runs against the application's database.
 * Real Nest controllers/JWT/Zod, services, SQL, Redis, billing and AI adapters.
 * /__product-test/chat is a loopback-only TEST adapter, not a production API.
 * LINE ingress/delivery are simulated; their network endpoints are forbidden.
 */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Test } = require('@nestjs/testing');
const { Logger } = require('@nestjs/common');
const { ConfigModule, ConfigService } = require('@nestjs/config');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { ZodValidationPipe } = require('nestjs-zod');
const { catalog, cases } = require('./product-test-data.cjs');
const load = (file, key) => require('../../dist/src/' + file + '.js')[key];
const PrismaService = load('prisma/prisma.service', 'PrismaService');
const ProductSearchService = load('modules/products/search/product-search.service', 'ProductSearchService');
const ProductIndexService = load('modules/products/search/product-index.service', 'ProductIndexService');
const ProductAttributeService = load('modules/products/attributes/product-attribute.service', 'ProductAttributeService');
const ProductService = load('modules/products/product.service', 'ProductService');
const { productPlanSchema } = require('../../dist/src/modules/products/search/product-search.types.js');
const { productPromptEvidence, productFactTokens, renderProductAnswer } = require('../../dist/src/modules/chatbot/knowledge/product/product-answer.policy.js');
const { buildProductAnswerPrompt } = require('../../dist/src/modules/chatbot/knowledge/product/utils/prompt/product-answer-prompt.js');
const { buildProductDocument } = require('../../dist/src/modules/products/search/product-document.js');
const { catalogFields } = require('../../dist/src/modules/products/search/catalog-fields.js');
const originalFetch = globalThis.fetch;
const diagnosticsOnly = process.env.PRODUCT_TEST_DIAGNOSTICS === '1';
const aiHosts = new Set(['openrouter.ai', 'generativelanguage.googleapis.com', 'api.openai.com', 'api.anthropic.com']);
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if ((diagnosticsOnly || !aiHosts.has(url.hostname)) && url.hostname !== '127.0.0.1') throw new Error('Unexpected outbound request');
  return originalFetch(input, init);
};
// Also block clients that use node http/https rather than fetch (notably LINE).
for (const protocol of ['http', 'https']) {
  const transport = require('node:' + protocol), original = transport.request;
  transport.request = function (...args) {
    const input = args[0];
    const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : (input.hostname || input.host || '').split(':')[0];
    if ((diagnosticsOnly || !aiHosts.has(host)) && !['127.0.0.1', 'localhost'].includes(host)) throw new Error('Unexpected outbound request');
    return original.apply(this, args);
  };
}
const dbUrl = new URL(process.env.DATABASE_URL);
assert.equal(dbUrl.hostname, '127.0.0.1');
assert.equal(dbUrl.pathname, '/product_test');
assert.equal(dbUrl.username, 'product_test');
assert.ok(process.env.PRODUCT_TEST_ISOLATED);
assert.ok(catalog.length <= 50);
const results = [], checks = [], warnings = [];
let app, moduleRef, db, redis, token, base, companyId, admin, search, indexer;
const created = new Map(), threads = new Map();
const report = () => {
  const document = { date: new Date().toISOString(), model: process.env.PRODUCT_TEST_MODEL || 'openai/gpt-6-luna', fixtureProducts: catalog.length, boundaries: { adminHTTP: 'real', chatHTTP: 'test-only loopback adapter to MessageProcessor', database: 'disposable PostgreSQL/pgvector', redis: 'disposable', ai: diagnosticsOnly ? 'forbidden' : 'live', line: 'simulated', billing: 'real services, synthetic wallet' }, results, checks, warnings };
  writeFileSync(join(process.env.PRODUCT_TEST_OUT, 'results.json'), JSON.stringify(document, null, 2));
  const cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const lines = ['# Product test: actual run', '', `Fashion: ${results.filter(r => r.pass).length}/${results.length} passed; diagnostic checks: ${checks.filter(r => r.pass).length}/${checks.length}.`, '', '| Case | Question | Expected | Actual | Result |', '| --- | --- | --- | --- | --- |', ...results.map(r => `| ${r.id} | ${cell(r.questions.join(' → '))} | ${cell(JSON.stringify(r.expect))} | ${cell(r.turns.at(-1)?.status)} | ${r.pass ? 'PASS' : cell(r.problems.join('; '))} |`), '', '## Diagnostic checks', '', ...checks.map(c => `- ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.error ? ': ' + c.error : ''}`), '', '## Conversations', ''];
  for (const r of results) { lines.push(`### ${r.id}`, '', ...r.turns.flatMap(t => [`Customer: ${t.question}`, '', `Bot: ${t.answer}`, '', `Decision: ${t.action}; ${t.status}; ${t.plan?.operation}; ${t.ms} ms`, ''])); }
  lines.push('## Boundaries', '', JSON.stringify(document.boundaries), '', 'Failures are findings. Expected decisions were not relaxed to make the run green. No production catalog, wallets, or LINE messages were changed.');
  writeFileSync(join(process.env.PRODUCT_TEST_OUT, 'results.md'), lines.join('\n'));
};
async function check(name, work) {
  try { await work(); checks.push({ name, pass: true }); }
  catch (e) { checks.push({ name, pass: false, error: e.message?.slice(0, 600) }); }
  console.log(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} diagnostic: ${name}`);
  report();
}
async function api(path, method = 'GET', body, expected = 200, auth = token) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: HTTP ${response.status} ${JSON.stringify(data).slice(0, 350)}`);
  return data;
}
async function main() {
  Logger.overrideLogger(false);
  const imports = [
    ['prisma/prisma.module', 'PrismaModule'], ['infra/redis/redis.module', 'RedisModule'],
    ['modules/usage/rate-limit/rate-limit.module', 'RateLimitModule'], ['modules/ai/ai-provider.module', 'AiProviderModule'],
    ['modules/usage/credit-point/credit.module', 'CreditServiceModule'], ['modules/admin/pricing/admin-ai-pricing.module', 'AdminAiPricingModule'],
    ['modules/chatbot/chatbot.module', 'ChatbotModule'], ['modules/admin/product/admin-product.module', 'AdminProductModule'],
  ].map(([file, key]) => load(file, key));
  moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ...imports] }).setLogger({ log() {}, warn() {}, debug() {}, verbose() {}, error(message) { warnings.push(String(message).slice(0, 200)); } }).compile();
  const get = (file, key) => moduleRef.get(load(file, key), { strict: false });
  db = moduleRef.get(PrismaService, { strict: false });
  redis = moduleRef.get('REDIS_CLIENT', { strict: false });
  const companyService = get('modules/admin/company/company.service', 'CompanyService');
  companyId = await companyService.getCompanyId();
  admin = await db.adminMember.create({ data: { username: 'product-audit-owner', password: 'synthetic-unusable-password', firstname: 'Audit', lastname: 'Owner', email: 'audit@example.invalid', phone: 'synthetic', role: 'owner', companyId } });
  token = get('modules/admin/auth/admin-jwt.service', 'AdminJwtService').sign(admin);
  const model = process.env.PRODUCT_TEST_MODEL || 'openai/gpt-6-luna';
  await get('modules/ai/ai-provider-settings.service', 'AiProviderSettingsService').update('USER', 'OPENROUTER', model);
  await get('modules/admin/pricing/ai-pricing-catalog.service', 'AiPricingCatalogService').seedDefaults();
  const topup = await db.creditTopupHistory.create({ data: { companyId, creditAmount: '200000', slipImage: 'audit/no-slip', requestedById: admin.id } });
  const AdminBillService = load('modules/admin/bill/admin-bill.service', 'AdminBillService');
  await new AdminBillService(db, companyService, { url: async () => null, remove: async () => {} }).confirmTopup(topup.id, admin.id);
  const defaults = require('../../dist/src/modules/chatbot/constants/ai-chat.constants.js');
  await db.aiSetting.create({ data: { systemPrompt: defaults.DEFAULT_SYSTEM_PROMPT, ownerPrompt: 'ตอบข้อมูลร้านจากหลักฐาน พูดภาษาไทยสุภาพ กระชับ', tone: 'สุภาพ', fallbackMessage: 'ข้อมูลยังไม่เพียงพอ กรุณาสอบถามเจ้าหน้าที่ค่ะ', active: true } });
  app = moduleRef.createNestApplication(new FastifyAdapter(), { logger: false });
  app.useGlobalPipes(new ZodValidationPipe());
  search = moduleRef.get(ProductSearchService, { strict: false });
  indexer = moduleRef.get(ProductIndexService, { strict: false });
  const context = get('modules/chatbot/context/load-context.service', 'LoadContextService');
  const processor = new (load('modules/events/message/message-processor.service', 'MessageProcessorService'))(get('modules/chatbot/chatbot.service', 'ChatbotService'), context);
  const router = get('modules/chatbot/intent-router.service', 'IntentRouterService');
  const resolve = router.resolve.bind(router);
  let decision;
  router.resolve = async (...args) => { decision = await resolve(...args); return decision; };
  const fastify = app.getHttpAdapter().getInstance();
  fastify.post('/__product-test/chat', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ message: 'Unauthorized' });
    const { text, caseId, repeatEvent } = request.body;
    if (typeof text !== 'string' || typeof caseId !== 'string') return reply.code(400).send({ message: 'Invalid test input' });
    let thread = threads.get(caseId);
    if (!thread) {
      const customer = await db.customer.create({ data: { companyId } });
      const member = await db.lineMember.create({ data: { lineUserId: 'U-audit-' + randomUUID(), displayName: 'Synthetic shopper', customerId: customer.id } });
      const conversation = await db.lineConversation.create({ data: { lineMemberId: member.id, lastMessage: 'audit', lastMessageType: 'TEXT', lastMessageAt: new Date() } });
      thread = { member, conversation }; threads.set(caseId, thread);
    }
    const eventId = repeatEvent ? thread.eventId : randomUUID();
    thread.eventId = eventId;
    let answer;
    decision = undefined;
    const before = await db.commerceLlmCall.count();
    const start = Date.now();
    await processor.process(eventId, {
      findDelivery: async () => null, // exercise durable CommerceTurn replay after a delivery-persistence crash
      saveIncomingEvent: async () => ({ conversationId: thread.conversation.id }),
      toChatTurn: async () => ({ kind: 'text', contextUserText: text, request: { userId: thread.member.lineUserId, lineMemberId: thread.member.id, conversationId: thread.conversation.id, turnId: eventId, text } }),
      saveReply: async (_event, _thread, _turn, response) => { answer = response; return { id: eventId }; },
      deliver: async () => context.appendTurn({ conversationId: thread.conversation.id, eventId, userText: text, response: answer }),
    });
    const turn = await db.commerceTurn.findFirst({ where: { companyId, externalEventId: eventId }, include: { calls: true } });
    const product = turn?.retrieval?.product;
    return { question: text, answer: answer?.text, source: answer?.source, action: decision?.action, plan: turn?.plan?.plan, status: product?.result?.status, evidence: product?.result?.evidence || [], total: product?.result?.total, businessType: product?.result?.businessType, failed: product?.failed, calls: turn?.calls.map(c => ({ slot: c.slot, failed: c.failed, decision: (() => { try { return JSON.parse(c.result?.text)?.decision; } catch { return undefined; } })() })), addedCalls: await db.commerceLlmCall.count() - before, ms: Date.now() - start };
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  await check('HTTP admin endpoint requires JWT', () => api('/api/admin/products', 'GET', undefined, 401, ''));
  await api('/api/admin/products/attributes/presets/FASHION/apply', 'POST', {}, 201);
  for (const item of catalog) {
    const body = { ...item, requestId: randomUUID(), variants: item.variants.map(({ stock, ...v }) => v) };
    const p = await api('/api/admin/products', 'POST', body, 201); created.set(item.name, p);
    for (const v of item.variants) {
      if (!v.stock || v.trackStock === false) continue;
      const actual = p.variants.find(row => row.sku === v.sku);
      await api(`/api/admin/products/${p.id}/variants/${actual.id}/stock-adjustments`, 'POST', { requestId: randomUUID(), expectedVersion: 1, deltaOnHand: v.stock, reason: 'Synthetic audit stock' }, 201);
    }
  }
  // No stock-reservation API exists yet. Set an explicit fixture reservation in isolated DB only.
  const stussy = created.get('Stussy Box Logo'), black = stussy.variants.find(v => v.sku === 'STUSSY-BOX-BK-M');
  await db.inventoryBalance.update({ where: { variantId: black.id }, data: { reserved: 3 } });
  for (let i = 0; !diagnosticsOnly && i < 30; i++) {
    await indexer.tick();
    if (await db.productVector.count() >= catalog.filter(p => p.status === 'ACTIVE').length) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!diagnosticsOnly) await check('real embedding outbox indexes every active fixture', async () => assert.equal(await db.productVector.count(), 12));
  const filter = process.env.PRODUCT_TEST_FILTER ? new RegExp(process.env.PRODUCT_TEST_FILTER) : null;
  for (const [id, input, expect] of cases.filter(c => !diagnosticsOnly && (!filter || filter.test(c[0])))) {
    const row = { id, questions: Array.isArray(input) ? input : [input], expect, turns: [], problems: [] };
    try {
      if (expect.mutateStock) {
        const balance = await db.inventoryBalance.findUnique({ where: { variantId: black.id } });
        await api(`/api/admin/products/${stussy.id}/variants/${black.id}/stock-adjustments`, 'POST', { requestId: randomUUID(), expectedVersion: balance.version, deltaOnHand: 2, reason: 'Live stock changed after indexing' }, 201);
      }
      for (const text of row.questions) row.turns.push(await api('/__product-test/chat', 'POST', { text, caseId: id }));
      const t = row.turns.at(-1), e = t.evidence, p = t.plan, answer = (t.answer || '').replace(/,/g, '');
      const demand = (condition, message) => { if (!condition) row.problems.push(message); };
      if (expect.status) demand(t.status === expect.status, `status expected ${expect.status}, got ${t.status}`);
      if (expect.operation) demand(p?.operation === expect.operation, `operation expected ${expect.operation}, got ${p?.operation}`);
      if (expect.product) demand(e.length && e.every(x => x.name === expect.product), 'wrong/missing product');
      if (expect.products) demand(expect.products.every(name => e.some(x => x.name === name)), 'comparison missing product');
      if (expect.sku) demand(e.length === 1 && e[0].sku === expect.sku, 'wrong/missing variant');
      if (expect.category) demand(e.length && e.every(x => x.category === expect.category), 'wrong/missing category');
      if (expect.brand) demand(e.length && e.every(x => x.details.some(d => d.key === 'brand' && d.value === expect.brand)), 'wrong/missing brand');
      if (expect.asks) demand(p?.asks.includes(expect.asks), 'missing ask ' + expect.asks);
      if (expect.listOption) demand(p?.listOptions.includes(expect.listOption), 'option enumeration missing');
      if (expect.inStockOnly) demand(p?.inStockOnly && e.every(x => x.stock === 'IN_STOCK'), 'in-stock constraint failed');
      if (expect.maxPrice) demand(e.length && e.every(x => x.price !== null && Number(x.price) <= Number(expect.maxPrice)), 'price upper bound failed');
      if (expect.minPrice) demand(e.length && e.every(x => x.price !== null && Number(x.price) >= Number(expect.minPrice)), 'price lower bound failed');
      if (expect.cheapest) demand(e[0]?.sku === expect.cheapest, 'wrong cheapest variant');
      if (expect.count !== undefined) demand(t.total === expect.count, `count expected ${expect.count}, got ${t.total}`);
      if (expect.quantity !== undefined) {
        const key = expect.quantitySource === 'ON_HAND' ? 'onHand' : 'availableStock';
        demand(e.length === 1 && e[0][key] === expect.quantity, `DB quantity expected ${expect.quantity}`);
        demand(new RegExp(`(^|[^0-9])${expect.quantity}([^0-9]|$)`).test(answer), 'answer missing actual stock quantity');
      }
      if (expect.quantitySource) demand(p?.stockQuantitySource === expect.quantitySource, 'wrong stock quantity source');
      if (expect.uniqueProducts) demand(new Set(e.map(x => x.productId)).size === expect.uniqueProducts, 'catalog list is incomplete');
      if (expect.text) for (const text of expect.text) demand(/^\d+$/.test(text) ? new RegExp(`(^|[^0-9])${text}(?:\\.00)?([^0-9]|$)`).test(answer) : answer.toLowerCase().includes(text.toLowerCase()), 'answer missing ' + text);
      if (expect.unknown) demand(e.length && e.every(x => x.price === null && x.availableStock === null) && /ไม่ได้|ยังไม่|ไม่ระบุ|ไม่ทราบ/.test(answer), 'unknown facts treated as known');
      if (expect.noProductAnswer) demand(t.status !== 'FOUND' || t.calls?.some(c => c.decision === 'INSUFFICIENT_CONTEXT'), 'unrelated/draft product answered');
      if (expect.clarify) demand(t.status !== 'UNAVAILABLE' && (['MISSING_INPUT', 'NO_MATCH'].includes(t.status) || /ระบุ|สินค้าไหน|ตัวไหน|เพิ่มเติม/.test(answer)), 'insufficient input not clarified');
      if (expect.noAuthenticity) demand(/ไม่|ยืนยัน|สอบถาม|เจ้าหน้าที่/.test(answer) && !/ของแท้แน่นอน|รับรองของแท้/.test(answer), 'unverified authenticity claim');
      if (expect.noFitGuarantee) demand(/ไม่|ยืนยัน|สอบถาม|เจ้าหน้าที่|ตาราง/.test(answer) && !/พอดีแน่นอน/.test(answer), 'fit uncertainty not explained (this is not proof of a false guarantee)');
      if (expect.forbidden) demand(!answer.includes(expect.forbidden), 'prompt injection fact accepted');
      if (t.failed) demand(false, 'workflow failed');
      if (expect.replay) {
        const repeated = await api('/__product-test/chat', 'POST', { text: row.questions[0], caseId: id, repeatEvent: true });
        demand(repeated.answer === t.answer && repeated.addedCalls === 0, 'replay changed answer or repeated model call');
      }
      for (const fact of e) {
        demand(!fact.options.some(x => ['bed_type', 'portion', 'spice_level'].includes(x.key)), 'foreign business evidence');
        if (fact.availableStock != null) demand(fact.availableStock === fact.onHand - fact.reserved, 'stock arithmetic mismatch');
      }
    } catch (error) { row.problems.push(error.message?.slice(0, 700)); }
    row.pass = row.problems.length === 0; results.push(row); report();
    console.log(`${row.pass ? 'PASS' : 'FAIL'} ${id}: ${row.problems.join('; ') || row.turns.at(-1)?.status}`);
  }
  // Stop the index poller during deterministic business-switch diagnostics.
  indexer.onModuleDestroy();
  await diagnostics(stussy, black);
  report();
  if (results.some(r => !r.pass) || checks.some(c => !c.pass)) process.exitCode = 1;
}

async function diagnostics(stussy, black) {
  const scope = { companyId }, plan = overrides => productPlanSchema.parse({ mode: 'PRODUCT', query: '', ...overrides });
  const run = p => search.search(scope, plan(p));
  await check('same-variant constraints cannot mix black M and white L', async () => assert.equal((await run({ productIds: [stussy.id], options: [{ key: 'color', value: 'ดำ' }, { key: 'size', value: 'L' }] })).status, 'VARIANT_UNAVAILABLE'));
  await check('price-only DETAIL searches the catalog without a subject', async () => assert.equal((await run({ maxPrice: '2000' })).status, 'FOUND'));
  await check('option-only DETAIL searches the catalog without a subject', async () => assert.equal((await run({ options: [{ key: 'color', value: 'ดำ' }] })).status, 'FOUND'));
  await check('ambiguity can be resolved by variant constraints', async () => {
    const result = await run({ query: 'เสื้อยืด', options: [{ key: 'color', value: 'ครีม' }, { key: 'size', value: 'L' }] });
    assert.equal(result.status, 'FOUND'); assert.equal(result.evidence[0].name, 'FOG Essentials Tee');
  });
  await check('stock adjustment retry creates one movement', async () => {
    const balance = await db.inventoryBalance.findUnique({ where: { variantId: black.id } });
    const body = { requestId: randomUUID(), expectedVersion: balance.version, deltaOnHand: 1, reason: 'Idempotency audit' };
    const path = `/api/admin/products/${stussy.id}/variants/${black.id}/stock-adjustments`;
    const a = await api(path, 'POST', body, 201), b = await api(path, 'POST', body, 201);
    assert.deepEqual(a, b);
    assert.equal(await db.inventoryMovement.count({ where: { command: { companyId, requestId: body.requestId } } }), 1);
  });
  await check('stale stock version returns conflict', () => api(`/api/admin/products/${stussy.id}/variants/${black.id}/stock-adjustments`, 'POST', { requestId: randomUUID(), expectedVersion: 1, deltaOnHand: 1, reason: 'stale version' }, 409));
  await check('oversell stock adjustment returns conflict', async () => {
    const b = await db.inventoryBalance.findUnique({ where: { variantId: black.id } });
    await api(`/api/admin/products/${stussy.id}/variants/${black.id}/stock-adjustments`, 'POST', { requestId: randomUUID(), expectedVersion: b.version, deltaOnHand: -b.onHand, reason: 'would consume reserved stock' }, 409);
  });
  await check('product creation idempotency is preserved', async () => {
    const p = catalog[0], body = { ...p, name: 'Audit replay tee', requestId: randomUUID(), variants: p.variants.slice(0, 1).map(({ stock, ...v }) => ({ ...v, sku: 'AUDIT-REPLAY' })) };
    const a = await api('/api/admin/products', 'POST', body, 201), b = await api('/api/admin/products', 'POST', body, 201);
    assert.equal(a.id, b.id);
  });
  await check('PATCH only fashion.color preserves meta brand/material/tags', async () => {
    const before = await api(`/api/admin/products/${stussy.id}`);
    const v = before.variants.find(v => v.id === black.id);
    await api(`/api/admin/products/${stussy.id}/variants/${black.id}`, 'PATCH', { requestId: randomUUID(), expectedVersion: v.version, expectedProductVersion: before.revision, fashion: { color: 'เขียว' } });
    const after = await db.productVariant.findUnique({ where: { id: black.id } });
    assert.equal(after.meta.brand, 'stussy'); assert.equal(after.meta.material, 'cotton 100%'); assert.deepEqual(after.meta.tags, ['ลำลอง', 'unisex']);
  });
  // Restore the fixture via the public API after the intentionally failing PATCH diagnostic.
  {
    const p = await api(`/api/admin/products/${stussy.id}`), v = p.variants.find(v => v.id === black.id);
    await api(`/api/admin/products/${stussy.id}/variants/${black.id}`, 'PATCH', { requestId: randomUUID(), expectedVersion: v.version, expectedProductVersion: p.revision, fashion: { color: 'ดำ' }, meta: { brand: 'stussy', material: 'cotton 100%', tags: ['ลำลอง', 'unisex'] } });
  }
  await check('empty subject/ambiguous input does not produce SQL error', async () => {
    const r = await run({ query: 'ราคาเท่าไร', ambiguous: true }); assert.ok(['MISSING_INPUT', 'NO_MATCH'].includes(r.status));
  });
  await check('known category COUNT includes records without a matching Thai alias', async () => assert.equal((await run({ query: 'เสื้อยืด', category: 't-shirt', operation: 'COUNT' })).total, 6));
  await check('stock QUANTITY question cannot render status-only answer', async () => {
    const p = plan({ query: 'เหลือกี่ชิ้น', productIds: [stussy.id], variantIds: [black.id], asks: ['STOCK'] });
    const result = await search.search(scope, p);
    assert.equal(renderProductAnswer(JSON.stringify({ decision: 'ANSWER', directlyAnswered: true, evidenceIds: [result.evidence[0].ref], answerTemplate: '{{e1.name}} {{e1.stockStatus}}' }), { scope, plan: p, result }, []), undefined);
  });
  await check('renderer rejects unsupported authenticity prose', async () => {
    const p = plan({ productIds: [stussy.id], variantIds: [black.id], asks: ['ATTRIBUTES'] }), result = await search.search(scope, p);
    assert.equal(renderProductAnswer(JSON.stringify({ decision: 'ANSWER', directlyAnswered: true, evidenceIds: [result.evidence[0].ref], answerTemplate: '{{e1.name}} รับรองของแท้แน่นอนค่ะ' }), { scope, plan: p, result }, []), undefined);
  });
  await check('index document respects category applicability of fields', async () => {
    const p = await db.product.findUnique({ where: { id: stussy.id }, include: { company: true, variants: { include: { fashion: true } } } });
    assert.ok(!buildProductDocument(p, catalogFields('FASHION', ['shirt'])).includes('cotton'), 't-shirt material indexed although only enabled for shirt');
  });
  await check('foreign company mutation is rejected', async () => {
    const other = await db.company.create({ data: { name: 'Mutation scope test' } });
    const service = moduleRef.get(ProductService, { strict: false });
    await assert.rejects(service.update({ companyId: other.id }, admin.id, stussy.id, { requestId: randomUUID(), expectedVersion: 1, name: 'forbidden' }));
    await db.company.delete({ where: { id: other.id } });
    assert.equal((await db.product.findUnique({ where: { id: stussy.id } })).name, 'Stussy Box Logo');
  });
  await check('archive removes product from search and preserves movements', async () => {
    const p = await db.product.findFirst({ where: { name: 'Audit replay tee' } });
    await api(`/api/admin/products/${p.id}`, 'DELETE', { requestId: randomUUID(), expectedVersion: p.revision });
    assert.equal((await run({ productIds: [p.id] })).evidence.length, 0);
    assert.equal((await db.product.findUnique({ where: { id: p.id } })).status, 'ARCHIVED');
  });
  await api('/api/admin/products/attributes/presets/HOTEL/apply', 'POST', {}, 201);
  const hotel = await api('/api/admin/products', 'POST', { name: 'Audit Family Suite', category: 'room', status: 'ACTIVE', variants: [{ sku: 'AUDIT-HOTEL', price: '3500.00', hotel: { bedType: 'king', maxGuests: 4, roomArea: '42.50' }, meta: { amenities: ['wifi', 'อ่างอาบน้ำ'] } }] }, 201);
  await check('HOTEL API persists typed fields and Decimal room area', async () => { assert.equal(hotel.variants[0].hotel.maxGuests, 4); assert.equal(hotel.variants[0].hotel.roomArea, '42.50'); });
  await check('HOTEL numeric filters and amenities hydrate correct evidence', async () => {
    const result = await run({ operation: 'LIST', filters: [{ key: 'max_guests', operator: 'GTE', value: '3' }, { key: 'room_area', operator: 'GTE', value: '42.49' }, { key: 'amenities', operator: 'CONTAINS', value: 'wifi' }] });
    assert.equal(result.status, 'FOUND'); assert.equal(result.evidence.length, 1); assert.equal(result.evidence[0].productId, hotel.id);
    assert.equal(result.evidence[0].details.find(f => f.key === 'room_area').value, '42.5 ตร.ม.');
    const evidence = productPromptEvidence({ scope, plan: plan({ asks: ['ATTRIBUTES'] }), result }, []);
    assert.equal(evidence.businessType, 'HOTEL'); assert.ok(buildProductAnswerPrompt(result.businessType).includes('business=HOTEL'));
    assert.ok(!JSON.stringify(evidence).includes('opt.color'));
  });
  await check('HOTEL planner exposes exactly the chosen business fields', async () => assert.deepEqual((await search.plannerCatalog(scope)).fields.map(f => f.key).sort(), ['tags', 'amenities', 'bed_type', 'max_guests', 'room_area'].sort()));
  await check('old Fashion rows do not appear in HOTEL catalog list', async () => {
    const r = await run({ operation: 'LIST' }); assert.ok(r.evidence.every(e => e.productId === hotel.id), 'old clothing still returned under HOTEL business');
  });
  await check('wrong-business variant payload is rejected by API', () => api('/api/admin/products', 'POST', { name: 'Wrong payload', status: 'ACTIVE', variants: [{ sku: 'WRONG-BUSINESS', fashion: { color: 'ดำ' } }] }, 400));
  await check('business changed after PLAN is rejected', async () => assert.rejects(search.search(scope, plan({ operation: 'LIST' }), undefined, 'th', 'FASHION'), /business changed/));
  await check('HOTEL price and stock are authoritative DB facts', async () => {
    await api(`/api/admin/products/${hotel.id}/variants/${hotel.variants[0].id}/stock-adjustments`, 'POST', { requestId: randomUUID(), expectedVersion: 1, deltaOnHand: 5, reason: 'hotel stock audit' }, 201);
    const r = await run({ productIds: [hotel.id], asks: ['PRICE', 'STOCK'] }); assert.equal(r.evidence[0].price, '3500.00'); assert.equal(r.evidence[0].availableStock, 5);
    assert.equal(productFactTokens({ scope, plan: plan({ asks: ['STOCK'] }), result: r }, [])['e1.stockQuantity'].value, '5');
  });
  await api('/api/admin/products/attributes/presets/RESTAURANT/apply', 'POST', {}, 201);
  const meal = await api('/api/admin/products', 'POST', { name: 'Audit ข้าวผัด', category: 'meal', status: 'ACTIVE', variants: [{ sku: 'AUDIT-MEAL', price: '89.00', restaurant: { portion: 'ใหญ่', spiceLevel: 'ไม่เผ็ด' }, meta: { ingredients: 'ข้าว ไข่', allergens: ['ไข่'] } }] }, 201);
  await check('RESTAURANT options/negative allergen filter use the same variant', async () => {
    const r = await run({ operation: 'LIST', options: [{ key: 'portion', value: 'ใหญ่' }], filters: [{ key: 'allergens', operator: 'NOT_CONTAINS', value: 'ถั่ว' }] });
    assert.equal(r.evidence.length, 1); assert.equal(r.evidence[0].productId, meal.id); assert.ok(buildProductAnswerPrompt(r.businessType).includes('business=RESTAURANT'));
  });
  await check('missing allergen facts do not satisfy NOT_CONTAINS', async () => assert.equal((await run({ productIds: [stussy.id], filters: [{ key: 'allergens', operator: 'NOT_CONTAINS', value: 'ถั่ว' }] })).evidence.length, 0));
  await check('Restaurant evidence excludes Fashion/Hotel fields', async () => {
    const r = await run({ productIds: [meal.id] }); assert.deepEqual(r.evidence[0].options.map(f => f.key).sort(), ['portion', 'spice_level']);
  });
  for (const type of ['GENERAL', 'ELECTRONICS', 'FOOD', 'BEAUTY']) {
    await check(`${type} planner fields follow preset and generic answer prompt`, async () => {
      await api(`/api/admin/products/attributes/presets/${type}/apply`, 'POST', {}, 201);
      assert.deepEqual((await search.plannerCatalog(scope)).fields.map(f => f.key), catalogFields(type).map(f => f.key));
      assert.ok(buildProductAnswerPrompt(type).includes('business=GENERAL'));
    });
    await check(`${type} all declared fields persist, filter and reach evidence`, async () => {
      const fields = catalogFields(type);
      const values = { brand: 'Audit Brand', tags: ['audit'], warranty: 'one year', color: 'ดำ', storage: '256GB', ingredients: 'ข้าว', allergens: ['ไข่'], shelf_life: 'one day', flavor: 'หวาน', net_weight: 'small', skin_type: ['แห้ง'], shade: 'แดง', volume: 'small' };
      const meta = Object.fromEntries(fields.map(f => [f.key, values[f.key]]));
      const p = await api('/api/admin/products', 'POST', { name: `Audit ${type}`, status: 'ACTIVE', variants: [{ sku: `AUDIT-${type}`, price: '100.00', meta }] }, 201);
      const filters = fields.filter(f => !f.variantOption).map(f => ({ key: f.key, operator: f.type === 'TAGS' ? 'CONTAINS' : 'EQ', value: Array.isArray(meta[f.key]) ? meta[f.key][0] : meta[f.key] }));
      const options = fields.filter(f => f.variantOption).map(f => ({ key: f.key, value: meta[f.key] }));
      const r = await run({ productIds: [p.id], filters, options }); assert.equal(r.status, 'FOUND');
      assert.deepEqual([...r.evidence[0].details, ...r.evidence[0].options].map(f => f.key).sort(), fields.map(f => f.key).sort());
    });
  }
  await api('/api/admin/products/attributes/presets/FASHION/apply', 'POST', {}, 201);
  await check('switching back restores Fashion fields and excludes Hotel detail', async () => {
    const r = await run({ productIds: [stussy.id], variantIds: [black.id] }); assert.equal(r.evidence[0].options.find(f => f.key === 'color').value, 'ดำ');
  });
  await check('index document omits price and stock', async () => {
    const p = await db.product.findUnique({ where: { id: stussy.id }, include: { company: true, variants: { include: { fashion: true, inventory: true } } } });
    const doc = JSON.parse(buildProductDocument(p, catalogFields('FASHION')));
    assert.ok(!JSON.stringify(doc).includes('2500')); assert.ok(!JSON.stringify(doc).includes('onHand'));
  });
  await check('foreign company cannot read or mutate products', async () => {
    const c = await db.company.create({ data: { name: 'Other isolated company' } });
    const service = moduleRef.get(ProductService, { strict: false });
    await assert.rejects(service.get({ companyId: c.id }, stussy.id), /not found/);
    assert.equal((await search.search({ companyId: c.id }, plan({ productIds: [stussy.id] }))).evidence.length, 0);
  });
}

main().catch(error => {
  // No raw provider responses, configuration values, tokens or production PII.
  console.error('Audit harness failed:', error.name, error.message?.slice(0, 500));
  warnings.push(`${error.name}: ${error.message?.slice(0, 500)}`);
  process.exitCode = 1;
}).finally(async () => {
  report();
  if (indexer) indexer.onModuleDestroy();
  if (app) await app.close();
  else if (moduleRef) await moduleRef.close();
  if (redis) redis.disconnect();
  if (db) await db.$disconnect();
});
