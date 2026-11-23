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
          {
            lastAct: 'ASKED',
            lastActAt: ago(10),
            handoffNoticeAt: ago(10),
          },
          { handoffPending: true },
        ),
      ).toBeNull();
    });

    it('lets an old question go', () => {
      expect(
        decide('ACK', { lastAct: 'ASKED', lastActAt: ago(1801) }),
      ).toMatchObject({ reply: 'ACK' });
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
      ).toEqual({ reply: 'SILENT' });
    });

    it('does not apply when the assistant spoke after the admin', () => {
      expect(
        decide('ACK', {
          lastAct: 'ANSWERED',
          lastActAt: ago(30),
          lastAdminAt: ago(60),
        }),
      ).toMatchObject({ reply: 'ACK' });
    });

    it('does not apply once the admin window has passed', () => {
      expect(decide('ACK', { lastAdminAt: ago(1801) })).toMatchObject({
        reply: 'ACK',
      });
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
    it.each([
      'PARTICLE_ONLY',
      'ACK',
      'THANKS',
      'CLOSING',
      'PING',
      'LAUGH',
    ] as const)('%s stays silent', (kind) => {
      expect(decide(kind, { lastAct: 'ACKED', lastActAt: ago(5) })).toEqual({
        reply: 'SILENT',
      });
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
      const [meta, extra] = waiting(6 * 3600);

      expect(decide('PARTICLE_ONLY', meta, extra)).toEqual({
        reply: 'HANDOFF_WAITING',
        act: 'HANDOFF_NOTICE',
      });
    });

    it('stays silent inside the cooldown, boundary included', () => {
      const [meta, extra] = waiting(900, 'HANDOFF_NOTICE');

      expect(decide('ACK', meta, extra)).toEqual({ reply: 'SILENT' });
      expect(decide('PING', ...waiting(901, 'HANDOFF_NOTICE'))).toMatchObject({
        reply: 'HANDOFF_WAITING',
      });
    });

    it('thanks and goodbyes get the thanks reply, not a nudge', () => {
      expect(decide('THANKS', ...waiting(30, 'HANDOFF_NOTICE'))).toEqual({
        reply: 'THANKS',
        act: 'ACKED',
      });
      expect(decide('CLOSING', ...waiting(7200))).toEqual({
        reply: 'THANKS',
        act: 'ACKED',
      });
    });

    it('does not apply to a room that is no longer waiting', () => {
      const [meta] = waiting(3600);

      expect(decide('ACK', meta, { handoffPending: false })).toMatchObject({
        reply: 'ACK',
      });
    });

    it('does not vouch for staff when the notice is too old or unknown', () => {
      expect(decide('ACK', ...waiting(86401))).toMatchObject({ reply: 'ACK' });
      expect(
        decide('ACK', { lastAct: 'ANSWERED' }, { handoffPending: true }),
      ).toMatchObject({ reply: 'ACK' });
    });

    it('a notice exactly at the maximum age still counts', () => {
      expect(decide('ACK', ...waiting(86400))).toMatchObject({
        reply: 'HANDOFF_WAITING',
      });
    });
  });

  describe('row 4: everything else', () => {
    it.each(['PARTICLE_ONLY', 'ACK', 'PING', 'LAUGH'] as const)(
      '%s gets the acknowledgement',
      (kind) => {
        expect(
          decide(kind, { lastAct: 'ANSWERED', lastActAt: ago(20) }),
        ).toEqual({
          reply: 'ACK',
          act: 'ACKED',
        });
      },
    );

    it.each(['THANKS', 'CLOSING'] as const)(
      '%s gets the thanks reply',
      (kind) => {
        expect(decide(kind)).toEqual({ reply: 'THANKS', act: 'ACKED' });
      },
    );

    it('answers an empty room (first message after a long gap) without a greeting reply', () => {
      expect(decide('PARTICLE_ONLY')).toEqual({ reply: 'ACK', act: 'ACKED' });
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
    ).toMatchObject({ reply: 'HANDOFF_WAITING' });
  });

  describe('the real conversation of 2026-11-23', () => {
    it('"ครัค่ะ" is told staff were notified, then "ครับ" gets nothing', () => {
      const handoffAt = ago(6 * 3600 + 11 * 60);
      // 11:38 handoff, 11:38 timetable answer, 17:49 "ครัค่ะ"
      const first = decide(
        'PARTICLE_ONLY',
        {
          lastAct: 'ANSWERED',
          lastActAt: handoffAt + 1000,
          handoffNoticeAt: handoffAt,
        },
        { handoffPending: true },
      );
      expect(first).toEqual({
        reply: 'HANDOFF_WAITING',
        act: 'HANDOFF_NOTICE',
      });

      // The reply was sent now; "ครับ" arrives a moment later.
      const second = decide(
        'PARTICLE_ONLY',
        {
          lastAct: 'HANDOFF_NOTICE',
          lastActAt: ago(2),
          handoffNoticeAt: ago(2),
        },
        { handoffPending: true },
      );
      expect(second).toEqual({ reply: 'SILENT' });
    });
  });
});
