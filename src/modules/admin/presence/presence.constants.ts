/** A viewer's heartbeat lapses this long after its last beat (client beats ~10s). */
export const VIEW_TTL_MS = 25_000;

/** Typing expires this long after the last typing=true (client resends ~3s). */
export const TYPING_TTL_MS = 6_000;

/** Redis key TTL refreshed on every write, so abandoned keys clean themselves up. */
export const KEY_TTL_SEC = 60;

export const ROOMS_SET_TTL_SEC = 86_400;

/** Caps how many chats one socket can watch at once. */
export const MAX_ROOMS_PER_SOCKET = 3;

/** Per-socket, per-room floor between typing=true writes to avoid spam. */
export const TYPING_MIN_INTERVAL_MS = 1_000;
