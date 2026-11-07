import type { Prisma } from '../../../generated/prisma/client';
import type {
  ChatResponse,
  KnowledgeItem,
  KnowledgeRetrievalResult,
} from '../../chatbot/shared/types/chat.types';
import type {
  DecisionAnswerType,
  DecisionCandidate,
  DecisionTraceState,
} from '../types/decision-log.types';
import { fit, logText } from './decision-log.sanitize';

const MAX_INPUT = 1000;
const MAX_RESPONSE = 2000;
const TOP_CANDIDATES = 3;

/** Registration is form input (names, phones, bank accounts) and its reply carries new credentials: never logged. */
const FORM_ACTIONS = new Set(['CONTINUE_REGISTER', 'START_REGISTER']);

export type DecisionLogOutcome = Readonly<{
  response?: ChatResponse;
  status: 'COMPLETED' | 'ERROR';
  errorCode?: string;
}>;

export type DecisionLogRow = Omit<
  Prisma.DecisionLogUncheckedCreateInput,
  'companyId'
>;

/** Builds the stored row from a finished trace. Pure: no I/O, no clock reads but `now`. */
export function buildDecisionLogRow(
  state: DecisionTraceState,
  outcome: DecisionLogOutcome,
  now = Date.now(),
): DecisionLogRow {
  const { meta, route, retrieval, answer } = state;
  const isForm =
    (route ? FORM_ACTIONS.has(route.action) : false) ||
    outcome.response?.source === 'REGISTRATION';
  const ranked = retrieval?.items ?? [];
  const businessFallback =
    (route?.action === 'CONTACT_ADMIN' || route?.action === 'FALLBACK') &&
    route.businessFallback === true;
  const isFallback = answer?.mode === 'FALLBACK' || businessFallback;
  const vectorScores = ranked.flatMap((item) =>
    numeric(item.metadata?.vectorSimilarity),
  );
  // Every candidate with a BM25 score counts, exact matches included.
  const lexicalScores = ranked.flatMap((item) =>
    numeric(item.metadata?.rawScore),
  );
  const candidates = retrieval ? topCandidates(retrieval) : [];
  // An exact-match hit is scored on the BM25 scale, not RRF: never mix them in one column.
  const comparableScore =
    retrieval && retrieval.route !== 'DIRECT' && !retrieval.product
      ? finite(retrieval.topScores[0])
      : null;
  const classifierFailed = state.notes.some(
    (note) => note.stage === 'classifier' && note.data.failed === true,
  );
  return {
    channel: meta.channel,
    eventId: fit(meta.eventId, 255) ?? '',
    // An identifier, not free text: stored as given (only cleaned and clipped) so a user can be looked up.
    userId: fit(meta.userId, 100) ?? '',
    conversationId: meta.conversationId ?? null,
    commerceTurnId:
      answer?.commerceTurnId ?? retrieval?.product?.turnId ?? null,
    messageType: fit(meta.messageType, 20) ?? '',
    inputText: isForm ? null : (logText(meta.input, MAX_INPUT) ?? null),
    retrievalQuery: isForm
      ? null
      : (logText(retrievalQuery(state), MAX_INPUT) ?? null),
    action: fit(route?.action, 40),
    intent: fit(route?.intent, 40),
    routeSource: fit(route?.source, 20),
    routeConfidence: finite(route?.confidence),
    routeReason: logText(route?.reason, 500) ?? null,
    answerType: fit(answerType(state, outcome.response), 30) ?? 'SYSTEM',
    // A reply nobody reported on came from a fixed template (rule, menu, sticker).
    answerMode: fit(answer?.mode ?? (outcome.response ? 'TEMPLATE' : null), 40),
    retrievalRoute: fit(retrieval?.route, 20),
    matchType: fit(retrieval?.matchType, 20),
    retrievalFallbackReason: fit(retrieval?.fallbackReason, 50),
    topScore: comparableScore,
    topVectorSimilarity: vectorScores.length ? Math.max(...vectorScores) : null,
    topLexicalScore: lexicalScores.length ? Math.max(...lexicalScores) : null,
    scoreGap: finite(retrieval?.scoreGap),
    candidateCount: ranked.length,
    candidates: candidates.length ? candidates : undefined,
    isFallback,
    // A failed classifier always ends in a handoff; retrieval's reason is then not the cause.
    fallbackReason: isFallback
      ? fit(
          answer?.fallbackReason ??
            (classifierFailed ? 'CLASSIFIER_FAILED' : undefined) ??
            route?.fallbackReason ??
            retrieval?.fallbackReason ??
            'UNREPORTED',
          60,
        )
      : null,
    handoffRequested: state.handoffRequested,
    responseSource: fit(outcome.response?.source, 20),
    contextPolicy: fit(outcome.response?.contextPolicy, 10),
    responseText: isForm
      ? null
      : (logText(outcome.response?.text, MAX_RESPONSE) ?? null),
    llmCallCount: state.llm.calls,
    llmInputTokens: state.llm.inputTokens,
    llmOutputTokens: state.llm.outputTokens,
    // Until the reply existed, not until LINE accepted it: delivery time is not the bot's.
    latencyMs: Math.max(0, (state.repliedAt ?? now) - state.startedAt),
    status: outcome.status,
    errorCode: fit(outcome.errorCode, 100),
    trace: state.notes as unknown as Prisma.InputJsonValue,
  };
}

/** Groups the turn by what answered it, not by how it was routed. */
export function answerType(
  state: Pick<DecisionTraceState, 'meta' | 'route' | 'retrieval' | 'answer'>,
  response?: ChatResponse,
): DecisionAnswerType {
  const { route, retrieval, answer } = state;
  if (state.meta.messageType === 'image') return 'IMAGE';
  if (!route) return response?.source === 'RULE' ? 'RULE' : 'SYSTEM';
  switch (route.action) {
    case 'ANSWER_KNOWLEDGE': {
      const mode = retrieval?.product?.plan.mode;
      if (mode === 'GENERAL') return 'GENERAL';
      if (mode === 'PRODUCT' || mode === 'BOTH') return 'PRODUCT';
      return knowledgeType(
        answer?.evidenceIds ??
          (retrieval?.selectedItems ?? []).map((item) => ref(item)),
      );
    }
    case 'GENERAL_QUESTION':
    case 'CONTINUE_AI_CHAT':
      return 'GENERAL';
    case 'RICH_MENU_REPLY':
      return 'MENU';
    case 'START_REGISTER':
    case 'CONTINUE_REGISTER':
      return 'REGISTRATION';
    case 'CONTACT_ADMIN':
    case 'FALLBACK':
      return 'HANDOFF';
    case 'DEFAULT':
      return 'SYSTEM';
    default:
      return 'RULE';
  }
}

function knowledgeType(refs: readonly string[]): DecisionAnswerType {
  const patterns = refs.some((id) => id.startsWith('ANSWER_PATTERN:'));
  const facts = refs.some((id) => id.startsWith('MICRO_KNOWLEDGE:'));
  if (patterns && facts) return 'MIXED_KNOWLEDGE';
  return facts ? 'MICRO_KNOWLEDGE' : 'KNOWLEDGE';
}

/** Top three ranked candidates plus selected evidence ranked below them. */
function topCandidates(
  retrieval: KnowledgeRetrievalResult,
): DecisionCandidate[] {
  const selected = new Set(retrieval.selectedItems.map(ref));
  const rows = retrieval.items.map((item, index) => ({
    item,
    rank: index + 1,
  }));
  const kept = rows.filter(
    ({ item, rank }) => rank <= TOP_CANDIDATES || selected.has(ref(item)),
  );
  // Selected evidence not among the ranked items (e.g. product rows) still shows.
  const ranked = new Set(retrieval.items.map(ref));
  const extra = retrieval.selectedItems
    .filter((item) => !ranked.has(ref(item)))
    .map((item) => ({ item, rank: 0 }));
  return [...kept, ...extra].map(({ item, rank }) => ({
    rank,
    ref: ref(item),
    source: item.source,
    title: logText(item.title, 120) ?? '',
    selected: selected.has(ref(item)),
    // Exact matches are scored on another scale and product rows carry a constant: neither is a rank score.
    fusedScore:
      retrieval.route === 'DIRECT' || item.source === 'PRODUCT'
        ? null
        : finite(item.score),
    lexicalScore: numeric(item.metadata?.rawScore)[0] ?? null,
    vectorSimilarity: numeric(item.metadata?.vectorSimilarity)[0] ?? null,
    matchTypes: matchTypes(item),
    exactMatch: item.metadata?.exactMatch === true,
  }));
}

function retrievalQuery(state: DecisionTraceState): string | undefined {
  for (let i = state.notes.length - 1; i >= 0; i--) {
    const query = state.notes[i].data.query;
    if (state.notes[i].stage === 'retrieval' && typeof query === 'string')
      return query;
  }
  return state.route?.resolvedQuery;
}

const ref = (item: KnowledgeItem) => `${item.source}:${item.id}`;

function matchTypes(item: KnowledgeItem): string[] {
  const types = item.metadata?.matchTypes;
  return Array.isArray(types)
    ? types.filter((type): type is string => typeof type === 'string')
    : [];
}

function numeric(value: unknown): number[] {
  return typeof value === 'number' && Number.isFinite(value) ? [value] : [];
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
