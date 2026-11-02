// Shared helpers for the load-test scripts.
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));

export const DATABASE_URL =
  process.env.LOAD_DATABASE_URL ??
  'postgresql://chatbot:loadtest@127.0.0.1:55432/chatbot_load?schema=public';

if (!/load|staging/i.test(DATABASE_URL)) {
  throw new Error('Refusing to run: LOAD_DATABASE_URL must name a load/staging database');
}

export function redisOptions() {
  return {
    host: process.env.LOAD_REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.LOAD_REDIS_PORT ?? 56379),
  };
}

export function loadRedis() {
  const Redis = require('ioredis');
  return new Redis(redisOptions());
}

/** Prisma client compiled with the app, so model names match the schema. */
export async function loadPrisma() {
  const dist = process.env.LOAD_DIST;
  if (!dist) throw new Error('LOAD_DIST must point at the compiled app root');
  const { PrismaClient, Prisma } = require(path.join(dist, 'src/generated/prisma/client.js'));
  const { PrismaPg } = require('@prisma/adapter-pg');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 4 }),
  });
  return { prisma, Prisma };
}

export function pg() {
  const { Pool } = require('pg');
  return new Pool({ connectionString: DATABASE_URL, max: 2 });
}

export const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
