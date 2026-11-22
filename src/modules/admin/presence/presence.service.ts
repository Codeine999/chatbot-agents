import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { z } from 'zod';
import { REDIS_CLIENT } from '../../../infra/redis/redis.module';
import {
  KEY_TTL_SEC,
  ROOMS_SET_TTL_SEC,
  TYPING_TTL_MS,
  VIEW_TTL_MS,
} from './presence.constants';
import { roomRefSchema } from './presence.schemas';
import type {
  PresenceChannel,
  PresenceRoom,
  PresenceViewer,
} from './presence.types';

const storedViewSchema = z.object({ n: z.string(), x: z.number() });

/** Viewing and typing live in Redis so every instance sees the same picture
 *  and entries expire on their own. Expiry is per admin, so each entry carries
 *  its own deadline and reads filter on it. */
@Injectable()
export class PresenceService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  roomKey(channel: PresenceChannel, conversationId: string): string {
    return `${channel}:${conversationId}`;
  }

  /** `added` is true when this admin was not a live viewer before, so the
   *  caller knows whether others need a fresh broadcast. */
  async touchView(
    scope: string,
    room: string,
    admin: { id: string; name: string },
  ): Promise<{ added: boolean }> {
    const now = Date.now();
    const view = this.viewKey(scope, room);
    const previous = this.parseView(await this.redis.hget(view, admin.id));
    const added = !previous || previous.expiresAt <= now;

    await this.redis.hset(
      view,
      admin.id,
      JSON.stringify({ n: admin.name, x: now + VIEW_TTL_MS }),
    );
    await this.redis.expire(view, KEY_TTL_SEC);
    await this.redis.sadd(this.roomsKey(scope), room);
    await this.redis.expire(this.roomsKey(scope), ROOMS_SET_TTL_SEC);
    return { added };
  }

  async removeAdmin(
    scope: string,
    room: string,
    adminId: string,
  ): Promise<void> {
    await this.redis.hdel(this.viewKey(scope, room), adminId);
    await this.redis.hdel(this.typeKey(scope, room), adminId);
  }

  async setTyping(
    scope: string,
    room: string,
    adminId: string,
    typing: boolean,
  ): Promise<void> {
    const key = this.typeKey(scope, room);
    if (!typing) {
      await this.redis.hdel(key, adminId);
      return;
    }
    await this.redis.hset(key, adminId, String(Date.now() + TYPING_TTL_MS));
    await this.redis.expire(key, KEY_TTL_SEC);
  }

  async snapshot(
    scope: string,
    channel: PresenceChannel,
    conversationId: string,
  ): Promise<PresenceRoom> {
    const now = Date.now();
    const room = this.roomKey(channel, conversationId);
    const views = await this.redis.hgetall(this.viewKey(scope, room));
    const typings = await this.redis.hgetall(this.typeKey(scope, room));

    const expiredViews: string[] = [];
    const viewers: PresenceViewer[] = [];
    for (const [adminId, raw] of Object.entries(views)) {
      const view = this.parseView(raw);
      if (!view || view.expiresAt <= now) {
        expiredViews.push(adminId);
        continue;
      }
      viewers.push({
        adminId,
        name: view.name,
        typing: Number(typings[adminId]) > now,
      });
    }

    const expiredTypings = Object.entries(typings)
      .filter(([, until]) => !(Number(until) > now))
      .map(([adminId]) => adminId);

    await this.prune(this.viewKey(scope, room), expiredViews);
    await this.prune(this.typeKey(scope, room), expiredTypings);

    viewers.sort((a, b) => a.adminId.localeCompare(b.adminId));
    return { channel, conversationId, viewers };
  }

  async snapshotAll(scope: string): Promise<PresenceRoom[]> {
    const roomsKey = this.roomsKey(scope);
    const rooms = await this.redis.smembers(roomsKey);
    const result: PresenceRoom[] = [];

    for (const room of rooms) {
      const ref = this.parseRoom(room);
      if (!ref) {
        await this.redis.srem(roomsKey, room);
        continue;
      }
      const snapshot = await this.snapshot(
        scope,
        ref.channel,
        ref.conversationId,
      );
      if (snapshot.viewers.length === 0) {
        await this.redis.srem(roomsKey, room);
        continue;
      }
      result.push(snapshot);
    }
    return result;
  }

  private viewKey(scope: string, room: string): string {
    return `presence:${scope}:view:${room}`;
  }

  private typeKey(scope: string, room: string): string {
    return `presence:${scope}:type:${room}`;
  }

  private roomsKey(scope: string): string {
    return `presence:${scope}:rooms`;
  }

  private parseView(
    raw: string | null | undefined,
  ): { name: string; expiresAt: number } | undefined {
    if (!raw) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = storedViewSchema.safeParse(json);
    return parsed.success
      ? { name: parsed.data.n, expiresAt: parsed.data.x }
      : undefined;
  }

  parseRoom(
    room: string,
  ): { channel: PresenceChannel; conversationId: string } | undefined {
    const separator = room.indexOf(':');
    if (separator < 0) return undefined;
    const parsed = roomRefSchema.safeParse({
      channel: room.slice(0, separator),
      conversationId: room.slice(separator + 1),
    });
    return parsed.success ? parsed.data : undefined;
  }

  /** Best effort: a failed cleanup only leaves an entry that expires anyway. */
  private async prune(key: string, fields: string[]): Promise<void> {
    if (fields.length === 0) return;
    await this.redis.hdel(key, ...fields).catch(() => 0);
  }
}
