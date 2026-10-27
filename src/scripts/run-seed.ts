import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

/**
 * Boots the app without an HTTP server, runs one seed, and exits.
 * The context starts BullMQ workers and Redis subscribers that keep the event
 * loop alive after close, so a seed run has to exit by itself.
 */
export async function runSeed(
  seed: (app: INestApplicationContext) => Promise<void>,
): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    await seed(app);
  } finally {
    await app.close();
  }
  process.exit(0);
}

export function failOnError(promise: Promise<void>): void {
  promise.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
