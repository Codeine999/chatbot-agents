import type { ChatResponse } from '../chatbot/shared/types/chat.types';

/** What clients and admins are told about a reply's origin. */
export type PublicReplySource = 'AI' | 'KNOWLEDGE' | 'RULE' | 'SYSTEM';

export type ReplyMetadata = Readonly<{
  /** Version of this shape; clients can rely on fields never changing meaning within one version. */
  v: 1;
  source: PublicReplySource | 'ADMIN';
  handoff: boolean;
  products: ReadonlyArray<{ productId: string }>;
}>;

const MAX_PRODUCTS = 20;
const MAX_BYTES = 4096;

/** Registration is not offered on app channels; clients only see it as a system message. */
export function publicSource(
  source: ChatResponse['source'],
): PublicReplySource {
  return source === 'REGISTRATION' ? 'SYSTEM' : source;
}

/**
 * Metadata for a bot reply. Built field by field from a whitelist: spreading
 * the core's response object would publish any internal field it gains later
 * (cost, company ids, scores).
 */
export function buildReplyMetadata(
  response: Pick<ChatResponse, 'source' | 'catalogRefs'>,
  handoff: boolean,
): ReplyMetadata {
  const seen = new Set<string>();
  const products: { productId: string }[] = [];
  for (const ref of response.catalogRefs ?? []) {
    if (typeof ref.productId !== 'string' || seen.has(ref.productId)) continue;
    seen.add(ref.productId);
    products.push({ productId: ref.productId });
    if (products.length >= MAX_PRODUCTS) break;
  }
  const metadata: ReplyMetadata = {
    v: 1,
    source: publicSource(response.source),
    handoff,
    products,
  };
  // The cap above keeps this far below the limit; the check guards future fields.
  return Buffer.byteLength(JSON.stringify(metadata)) <= MAX_BYTES
    ? metadata
    : { ...metadata, products: [] };
}

/** Metadata of a message an admin typed in the inbox. */
export const ADMIN_REPLY_METADATA: ReplyMetadata = {
  v: 1,
  source: 'ADMIN',
  handoff: false,
  products: [],
};
