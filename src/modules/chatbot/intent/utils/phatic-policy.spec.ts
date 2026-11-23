import type { TurnMeta } from '../../state/turn-meta.store';
import {
  DEFAULT_PHATIC_LIMITS,
  decidePhatic,
  type PhaticContext,
} from './phatic-policy';

const NOW = 1_700_000_000_000;
const ago = (seconds: number) => NOW - seconds * 1000;

const decide = (
  kind: Parameters<typeof decidePhatic>[0],
  meta: TurnMeta = {},
  extra: Partial<PhaticContext> = {},
) => decidePhatic(kind, { meta, handoffPending: false, now: NOW, ...extra });

const KINDS = [
  'PARTICLE_ONLY',
  'ACK',
  'THANKS',
  'CLOSING',
  'PING',
  'LAUGH',
] as const;

const GENERAL = { reply: 'GENERAL' };
const SILENT = { reply: 'SILENT' };

describe('decidePhatic', () => {
  describe('row 0: the assistant asked and is waiting', () => {
    it('steps aside while the question is recent', () => {
      expect(
        decide('PARTICLE_ONLY', { lastAct: 'ASKED', lastActAt: ago(60) }),
      ).toBeNull();
      expect(
        decide('ACK', { lastAct: 'ASKED', lastActAt: ago(1800) }),
      ).toBeNull();
    });

    it('steps aside even for thanks, and even while waiting for staff', () => {
      expect(
        decide(
          'THANKS',
          { lastAct: 'ASKED', lastActAt: ago(10), handoffNoticeAt: ago(10) },
          { handoffPending: true },
        ),
      ).toBeNull();
    });

    it('lets an old question go to general chat', () => {
      expect(decide('ACK', { lastAct: 'ASKED', lastActAt: ago(1801) })).toEqual(
        GENERAL,
      );
    });
  });

  describe('row 1: an admin spoke last, recently', () => {
    it('stays silent', () => {
      expect(
        decide('THANKS', {
          lastAct: 'ANSWERED',
          lastActAt: ago(300),
          lastAdminAt: ago(60),
        }),
      ).toEqual(SILENT);
    });

    it('does not apply when the assistant spoke after the admin', () => {
      expect(
        decide('ACK', {
          lastAct: 'ANSWERED',
          lastActAt: ago(30),
          lastAdminAt: ago(60),
        }),
      ).toEqual(GENERAL);
    });

    it('does not apply once the admin window has passed', () => {
      expect(decide('ACK', { lastAdminAt: ago(1801) })).toEqual(GENERAL);
    });

    it('is overridden by an open question from the assistant', () => {
      expect(
        decide('ACK', {
          lastAct: 'ASKED',
          lastActAt: ago(900),
          lastAdminAt: ago(30),
        }),
      ).toBeNull();
    });
  });

  describe('row 2: an acknowledgement was just answered', () => {
    it.each(KINDS)('%s stays silent', (kind) => {
      expect(decide(kind, { lastAct: 'ACKED', lastActAt: ago(5) })).toEqual(
        SILENT,
      );
    });

    it('stays silent up to the recent window, boundary included', () => {
      expect(decide('ACK', { lastAct: 'ACKED', lastActAt: ago(1800) })).toEqual(
        SILENT,
      );
    });

    it('answers again once the window has passed: TurnMeta lives a day', () => {
      expect(
        decide('PARTICLE_ONLY', { lastAct: 'ACKED', lastActAt: ago(1801) }),
      ).toEqual(GENERAL);
      expect(
        decide('PING', { lastAct: 'ACKED', lastActAt: ago(5 * 3600) }),
      ).toEqual(GENERAL);
    });

    it('does not trust an acknowledgement with no time', () => {
      expect(decide('ACK', { lastAct: 'ACKED' })).toEqual(GENERAL);
    });
  });

  describe('row 3: the room is waiting for staff', () => {
    const waiting = (
      noticeAgo: number,
      lastAct: TurnMeta['lastAct'] = 'ANSWERED',
    ) =>
      [
        {
          lastAct,
          lastActAt: ago(noticeAgo - 1),
          handoffNoticeAt: ago(noticeAgo),
        },
        { handoffPending: true },
      ] as const;

    it('tells the customer staff were notified, after the cooldown', () => {
      expect(decide('PARTICLE_ONLY', ...waiting(6 * 3600))).toEqual({
        reply: 'HANDOFF_WAITING',
      });
    });

    it('stays silent inside the cooldown, boundary included', () => {
      expect(decide('ACK', ...waiting(900, 'HANDOFF_NOTICE'))).toEqual(SILENT);
      expect(decide('PING', ...waiting(901, 'HANDOFF_NOTICE'))).toEqual({
        reply: 'HANDOFF_WAITING',
      });
    });

    it.each(KINDS)('%s is handled by code while waiting', (kind) => {
      expect(decide(kind, ...waiting(30, 'HANDOFF_NOTICE'))).toEqual(SILENT);
      expect(decide(kind, ...waiting(7200))).toEqual({
        reply: 'HANDOFF_WAITING',
      });
    });

    it('a photo sent to staff counts: only the notice time is known', () => {
      expect(
        decide(
          'PING',
          {
            lastAct: 'ANSWERED',
            lastActAt: ago(3600),
            handoffNoticeAt: ago(60),
          },
          { handoffPending: true },
        ),
      ).toEqual(SILENT);
    });

    it('does not apply to a room that is no longer waiting', () => {
      const [meta] = waiting(3600);

      expect(decide('ACK', meta, { handoffPending: false })).toEqual(GENERAL);
    });

    it('does not vouch for staff when the notice is too old or unknown', () => {
      expect(decide('ACK', ...waiting(86401))).toEqual(GENERAL);
      expect(
        decide('ACK', { lastAct: 'ANSWERED' }, { handoffPending: true }),
      ).toEqual(GENERAL);
    });

    it('a notice exactly at the maximum age still counts', () => {
      expect(decide('ACK', ...waiting(86400))).toEqual({
        reply: 'HANDOFF_WAITING',
      });
    });
  });

  describe('row 4: everything else goes to general chat', () => {
    it.each(KINDS)('%s after an answer', (kind) => {
      expect(decide(kind, { lastAct: 'ANSWERED', lastActAt: ago(20) })).toEqual(
        GENERAL,
      );
    });

    it('an empty room (a first "ครับ" or "ฮัลโหล")', () => {
      expect(decide('PARTICLE_ONLY')).toEqual(GENERAL);
      expect(decide('PING')).toEqual(GENERAL);
    });
  });

  it('uses the configured windows', () => {
    const limits = { ...DEFAULT_PHATIC_LIMITS, handoffPingCooldownSec: 60 };

    expect(
      decide(
        'ACK',
        {
          lastAct: 'HANDOFF_NOTICE',
          lastActAt: ago(120),
          handoffNoticeAt: ago(120),
        },
        { handoffPending: true, limits },
      ),
    ).toEqual({ reply: 'HANDOFF_WAITING' });
    expect(
      decide(
        'ACK',
        { lastAct: 'ACKED', lastActAt: ago(120) },
        { limits: { ...DEFAULT_PHATIC_LIMITS, recentWindowSec: 60 } },
      ),
    ).toEqual(GENERAL);
  });

  describe('the real conversation of 2026-11-23', () => {
    it('"ครัค่ะ" is told staff were notified, then "ครับ" gets nothing', () => {
      const handoffAt = ago(6 * 3600 + 11 * 60);
      // 11:38 handoff, 11:38 timetable answer, 17:49 "ครัค่ะ"
      expect(
        decide(
          'PARTICLE_ONLY',
          {
            lastAct: 'ANSWERED',
            lastActAt: handoffAt + 1000,
            handoffNoticeAt: handoffAt,
          },
          { handoffPending: true },
        ),
      ).toEqual({ reply: 'HANDOFF_WAITING' });

      // The reply was sent now; "ครับ" arrives a moment later.
      expect(
        decide(
          'PARTICLE_ONLY',
          {
            lastAct: 'HANDOFF_NOTICE',
            lastActAt: ago(2),
            handoffNoticeAt: ago(2),
          },
          { handoffPending: true },
        ),
      ).toEqual(SILENT);
    });
  });
});
