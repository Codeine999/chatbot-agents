import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/** Expands an IPv6 address to its 8 groups, or null if it is malformed. */
function ipv6Groups(address: string): string[] | null {
  const bare = address.split('%')[0].toLowerCase();
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array<string>(missing).fill('0'), ...tail].map((group) =>
    group.padStart(4, '0'),
  );
}

/**
 * The part of an address that identifies one network user: the whole IPv4
 * address, or the /64 prefix of an IPv6 one (a single device rotates through
 * its /64, so hashing the full address would give it unlimited identities).
 */
function ipIdentity(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped ? mapped[1] : ip;
  if (isIPv4(address)) return address;
  if (isIPv6(address)) {
    const groups = ipv6Groups(address);
    if (groups) return `${groups.slice(0, 4).join(':')}::/64`;
  }
  return 'unknown';
}

/**
 * Salted hash used for per-IP limits and session counting. The raw address is
 * personal data, so it is never stored or logged.
 */
export function clientIpHash(ip: string | undefined, salt: string): string {
  return createHash('sha256')
    .update(`${ipIdentity(ip)}|${salt}`)
    .digest('hex')
    .slice(0, 32);
}
