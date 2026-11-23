import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { TurnMetaStore, askedTextOf } from './turn-meta.store';

/** Hashes with TTL, MULTI and per-command failure: just what the store uses. */
function fakeRedis(options: { failOn?: string } = {}) {
  const hashes = new Map<string, Record<string, string>>();
  const ttl = new Map<string, number>();
  const fail = (command: string) => {
    if (options.failOn === command) throw new Error(`${command} down`);
  };

  const multi = () => {
    const ops: (() => void)[] = [];
    const chain = {
      hset: (key: string, fields: Record<string, string>) => {
        ops.push(() => {
          fail('hset');
          hashes.set(key, { ...hashes.get(key), ...fields });
        });
        return chain;
      },
      hdel: (key: string, field: string) => {
        ops.push(() => {
          const hash = { ...hashes.get(key) };
          delete hash[field];
          hashes.set(key, hash);
        });
        return chain;
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => ttl.set(key, seconds));
        return chain;
      },
      exec: () => {
        try {
          ops.forEach((op) => op());
          return Promise.resolve([[null, 1]]);
        } catch (error) {
          return Promise.resolve([[error as Error, null]]);
        }
      },
    };
    return chain;
  };

  return {
    hashes,
    ttl,
    multi,
    hgetall: (key: string) => {
      fail('hgetall');
      return Promise.resolve({ ...hashes.get(key) });
    },
    del: (key: string) => {
      fail('del');
      hashes.delete(key);
      return Promise.resolve(1);
    },
  };
}

const store = (
  env: Record<string, string> = { PHATIC_FAST_PATH_ENABLED: 'true' },
  redis = fakeRedis(),
) =>
  ({
    redis,
    store: new TurnMetaStore(
      redis as unknown as Redis,
      {
        get: (key: string) => env[key],
      } as unknown as ConfigService,
    ),
  }) as const;

describe('TurnMetaStore', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(1_000_000));
  afterEach(() => jest.useRealTimers());

  it('keeps assistant and admin facts in separate fields of one hash', async () => {
    const { redis, store: meta } = store();

    await meta.markAssistant('c1', 'ANSWERED');
    jest.setSystemTime(2_000_000);
    await meta.markAdmin('c1');

    expect(redis.hashes.get('chat:turnmeta:c1')).toEqual({
      lastAct: 'ANSWERED',
      lastActAt: '1000000',
      lastAdminAt: '2000000',
    });
    expect(await meta.load('c1')).toEqual({
      lastAct: 'ANSWERED',
      lastActAt: 1_000_000,
      lastAdminAt: 2_000_000,
    });
  });

  it('renews the TTL on every write (default one day)', async () => {
    const { redis, store: meta } = store();

    await meta.markAssistant('c1', 'ACKED');
    expect(redis.ttl.get('chat:turnmeta:c1')).toBe(86400);

    redis.ttl.clear();
    await meta.markAdmin('c1');
    expect(redis.ttl.get('chat:turnmeta:c1')).toBe(86400);
  });

  it('honours TURN_META_TTL_SEC', async () => {
    const { redis, store: meta } = store({
      PHATIC_FAST_PATH_ENABLED: 'true',
      TURN_META_TTL_SEC: '600',
    });

    await meta.markAssistant('c1', 'ACKED');

    expect(redis.ttl.get('chat:turnmeta:c1')).toBe(600);
  });

  it('records the handoff notice time only for HANDOFF_NOTICE', async () => {
    const { store: meta } = store();

    await meta.markAssistant('c1', 'HANDOFF_NOTICE');
    expect((await meta.load('c1')).handoffNoticeAt).toBe(1_000_000);

    jest.setSystemTime(3_000_000);
    await meta.markAssistant('c1', 'ANSWERED');
    expect(await meta.load('c1')).toMatchObject({
      lastAct: 'ANSWERED',
      lastActAt: 3_000_000,
      handoffNoticeAt: 1_000_000,
    });
  });

  it('keeps the question only while the last act is ASKED', async () => {
    const { store: meta } = store();

    await meta.markAssistant('c1', 'ASKED', 'เดินทางวันไหนคะ');
    expect((await meta.load('c1')).askedText).toBe('เดินทางวันไหนคะ');

    await meta.markAssistant('c1', 'ANSWERED');
    expect((await meta.load('c1')).askedText).toBeUndefined();
  });

  it('clear forgets the room', async () => {
    const { store: meta } = store();
    await meta.markAssistant('c1', 'ANSWERED');

    await meta.clear('c1');

    expect(await meta.load('c1')).toEqual({});
  });

  it('ignores a stored value it does not understand', async () => {
    const { redis, store: meta } = store();
    redis.hashes.set('chat:turnmeta:c1', {
      lastAct: 'SOMETHING_ELSE',
      lastActAt: 'soon',
      lastAdminAt: '-5',
    });

    expect(await meta.load('c1')).toEqual({});
  });

  describe('when Redis fails', () => {
    it.each(['hgetall', 'hset', 'del'])('%s degrades quietly', async (cmd) => {
      const { store: meta } = store(
        { PHATIC_FAST_PATH_ENABLED: 'true' },
        fakeRedis({ failOn: cmd }),
      );

      await expect(meta.load('c1')).resolves.toEqual({});
      await expect(meta.markAssistant('c1', 'ACKED')).resolves.toBeUndefined();
      await expect(meta.markAdmin('c1')).resolves.toBeUndefined();
      await expect(meta.clear('c1')).resolves.toBeUndefined();
    });
  });

  describe('with the flag off', () => {
    it('reads and writes nothing', async () => {
      const { redis, store: meta } = store({});

      await meta.markAssistant('c1', 'ANSWERED');
      await meta.markAdmin('c1');

      expect(meta.enabled).toBe(false);
      expect(redis.hashes.size).toBe(0);
      expect(await meta.load('c1')).toEqual({});
    });

    it('rejects a flag that is not true or false', () => {
      expect(() => store({ PHATIC_FAST_PATH_ENABLED: 'yes' })).toThrow(
        'PHATIC_FAST_PATH_ENABLED must be true or false',
      );
    });
  });

  it('askedTextOf redacts PII and keeps at most 300 characters', () => {
    expect(askedTextOf('ก'.repeat(500))).toHaveLength(300);
    expect(askedTextOf('โทร 0812345678 ได้ไหมคะ')).not.toContain('0812345678');
  });
});
