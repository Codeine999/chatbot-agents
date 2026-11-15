import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../infra/redis/redis.module';

const PAUSED_KEY = 'chat:pipeline:paused';

export type PipelineSwitchState = {
  paused: boolean;
  /** `redis` = set at runtime by an admin; `env` = no runtime value, using CHAT_PIPELINE_PAUSED. */
  source: 'redis' | 'env';
  envDefault: boolean;
};

/**
 * Global stop for the answering pipeline. While paused, inbound messages are
 * still stored but get no search, no model call and no reply.
 *
 * The runtime value lives in Redis so it flips instantly across instances; the
 * CHAT_PIPELINE_PAUSED env var is the default when Redis holds nothing. If
 * Redis is unreachable the pipeline fails OPEN (answers normally) so a cache
 * outage never silences the bot.
 */
@Injectable()
export class PipelineSwitchService {
  private readonly logger = new Logger(PipelineSwitchService.name);
  private readonly envDefault: boolean;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.envDefault =
      String(config.get('CHAT_PIPELINE_PAUSED') ?? 'false').toLowerCase() ===
      'true';
  }

  async isPaused(): Promise<boolean> {
    try {
      const raw = await this.redis.get(PAUSED_KEY);
      return raw === null ? this.envDefault : raw === '1';
    } catch (error) {
      this.logger.error(
        'pipeline switch read failed, answering normally',
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  async getState(): Promise<PipelineSwitchState> {
    const raw = await this.redis.get(PAUSED_KEY);
    return {
      paused: raw === null ? this.envDefault : raw === '1',
      source: raw === null ? 'env' : 'redis',
      envDefault: this.envDefault,
    };
  }

  async setPaused(paused: boolean): Promise<PipelineSwitchState> {
    await this.redis.set(PAUSED_KEY, paused ? '1' : '0');
    this.logger.warn(`chat pipeline ${paused ? 'PAUSED' : 'RESUMED'}`);
    return this.getState();
  }
}
