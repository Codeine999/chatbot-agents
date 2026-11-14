export const CHANNEL_KINDS = {
  LINE: {
    userIdPrefix: '',
    logChannel: 'LINE',
    registration: true,
    store: 'line',
  },
  APP: {
    userIdPrefix: 'app:',
    logChannel: 'APPLICATION',
    registration: false,
    store: 'channel',
  },
  FACEBOOK: {
    userIdPrefix: 'fb:',
    logChannel: 'FACEBOOK',
    registration: false,
    store: 'channel',
  },
} as const satisfies Record<
  string,
  Readonly<{
    userIdPrefix: string;
    logChannel: string;
    registration: boolean;
    store: 'line' | 'channel';
  }>
>;

export type ChatChannelKind = keyof typeof CHANNEL_KINDS;

/** Channels stored in channel* tables; equals the Prisma `ChatChannel` enum. */
export type StoredChannelKind = {
  [K in ChatChannelKind]: (typeof CHANNEL_KINDS)[K]['store'] extends 'channel'
    ? K
    : never;
}[ChatChannelKind];

export const STORED_CHANNEL_KINDS = (
  Object.keys(CHANNEL_KINDS) as ChatChannelKind[]
).filter(
  (kind): kind is StoredChannelKind => CHANNEL_KINDS[kind].store === 'channel',
);

export const isStoredChannelKind = (
  value: string,
): value is StoredChannelKind =>
  (STORED_CHANNEL_KINDS as readonly string[]).includes(value);

/** Session/chatbot user id of a channel* contact. */
export const channelUserId = (kind: StoredChannelKind, contactId: string) =>
  `${CHANNEL_KINDS[kind].userIdPrefix}${contactId}`;
