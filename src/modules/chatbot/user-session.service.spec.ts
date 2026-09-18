import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { UserSessionService } from './user-session.service';
import { NotificationService } from '../admin/notification/notification.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('independent admin requests and timed control', () => {
  function setup() {
    let now = 0;
    let waiting = false;
    const keys = new Map<string, { value: string; until: number }>();
    const read = (key: string) => {
      const entry = keys.get(key);
      return entry && entry.until > now ? entry.value : null;
    };
    const redis = {
      get: jest.fn((key: string) => Promise.resolve(read(key))),
      getex: jest.fn((key: string, _ex: string, ttl: number) => {
        const value = read(key);
        if (value) keys.set(key, { value, until: now + ttl });
        return Promise.resolve(value);
      }),
      set: jest.fn((key: string, value: string, _ex: string, ttl: number) => {
        keys.set(key, { value, until: now + ttl });
        return Promise.resolve('OK');
      }),
      del: jest.fn((key: string) => Promise.resolve(keys.delete(key))),
    };
    const notify = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      lineConversation: {
        updateMany: jest.fn(() => {
          const count = waiting ? 0 : 1;
          waiting = true;
          return Promise.resolve({ count });
        }),
      },
    };
    const service = new UserSessionService(
      redis as unknown as Redis,
      new ConfigService({ AUTO_MUTE_WHEN_REPLY: '10m' }),
      { notifyAdminRequired: notify } as unknown as NotificationService,
      prisma as unknown as PrismaService,
    );
    return {
      service,
      notify,
      redis,
      advance: (seconds: number) => {
        now += seconds;
      },
    };
  }

  const workflow = {
    userId: 'user',
    flow: 'REGISTER' as const,
    step: 'SEND_REGISTER_FORM',
    status: 'ACTIVE' as const,
    data: { firstName: 'fixture' },
  };

  it('requests notify once, retain registration data, and leave AI enabled', async () => {
    const { service, notify } = setup();
    await service.set('user', workflow);
    await Promise.all([
      service.requestAdmin('user'),
      service.requestAdmin('user'),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      userId: 'user',
      flow: 'REGISTER',
      step: 'SEND_REGISTER_FORM',
      status: 'ACTIVE',
    });
    expect(await service.get('user')).toEqual(workflow);
    expect(await service.isMuted('user')).toBe(false);
  });

  it('a request without a workflow reports CONTACT_ADMIN/WAITING_ADMIN', async () => {
    const { service, notify } = setup();
    await service.requestAdmin('user');
    expect(notify).toHaveBeenCalledWith({
      userId: 'user',
      flow: 'CONTACT_ADMIN',
      step: 'WAITING_ADMIN',
      status: 'ACTIVE',
    });
  });

  it('refreshes to ten minutes, never accumulates TTL, and reads do not extend mute', async () => {
    const { service, advance } = setup();
    await service.requestAdmin('user');
    await service.mute('user');
    advance(120);
    await service.mute('user');
    advance(599);
    expect(await service.isMuted('user')).toBe(true);
    advance(1);
    expect(await service.isMuted('user')).toBe(false);
  });

  it('clear workflow cannot unmute, and resume preserves the workflow', async () => {
    const { service } = setup();
    await service.set('user', workflow);
    await service.mute('user', 'PAUSE');
    await service.resume('user');
    expect(await service.get('user')).toEqual(workflow);
    await service.mute('user');
    await service.clear('user');
    expect(await service.isMuted('user')).toBe(true);
  });

  it('control state never leaks into the stored workflow', async () => {
    const { service, redis } = setup();
    const legacy = { ...workflow, controlMode: 'ADMIN', requiAdmin: true };
    await redis.set('chat:session:user', JSON.stringify(legacy), 'EX', 60);
    expect(await service.get('user')).toEqual(workflow);
    expect(await service.isMuted('user')).toBe(false);
    await service.set('user', legacy);
    expect(JSON.parse(redis.set.mock.calls.at(-1)?.[1] ?? '')).toEqual(
      workflow,
    );
  });
});
