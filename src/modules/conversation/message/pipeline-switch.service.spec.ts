import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { PipelineSwitchService } from './pipeline-switch.service';

const build = (redisGet: () => Promise<string | null>, envDefault?: string) => {
  const redis = {
    get: jest.fn(redisGet),
    set: jest.fn().mockResolvedValue('OK'),
  } as unknown as Redis;
  const config = {
    get: () => envDefault,
  } as unknown as ConfigService;
  return new PipelineSwitchService(redis, config);
};

describe('PipelineSwitchService', () => {
  it('uses the env default when Redis holds nothing', async () => {
    expect(await build(() => Promise.resolve(null)).isPaused()).toBe(false);
    expect(await build(() => Promise.resolve(null), 'true').isPaused()).toBe(
      true,
    );
  });

  it('lets the Redis value override the env default', async () => {
    expect(await build(() => Promise.resolve('0'), 'true').isPaused()).toBe(
      false,
    );
    expect(await build(() => Promise.resolve('1')).isPaused()).toBe(true);
  });

  it('fails open when Redis is down, even if env says paused', async () => {
    const service = build(() => Promise.reject(new Error('down')), 'true');
    expect(await service.isPaused()).toBe(false);
  });
});
