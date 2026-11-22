import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';
import {
  CHANNEL_KINDS,
  isStoredChannelKind,
} from '../../../shared/channel/channel-kinds';
import type { AuthenticatedAdmin } from '../../../shared/guards/admin-auth.types';
import { ADMIN_SOCKET_GATEWAY_OPTIONS } from '../admin-socket.options';
import {
  MAX_ROOMS_PER_SOCKET,
  TYPING_MIN_INTERVAL_MS,
} from './presence.constants';
import { roomRefSchema, typingSchema } from './presence.schemas';
import { PresenceService } from './presence.service';
import type {
  PresenceAck,
  PresenceChannel,
  PresenceFailure,
  PresenceRoom,
} from './presence.types';

interface PresenceSocketData {
  admin?: AuthenticatedAdmin;
  scopeP?: Promise<string>;
  rooms?: Set<string>;
  typingAt?: Map<string, number>;
}

const scopeRoom = (scope: string) => `presence:${scope}`;

/** Display-only presence. Every handler returns its ack; Nest sends the return
 *  value back to the client's ack callback. Handlers never throw. */
@WebSocketGateway(ADMIN_SOCKET_GATEWAY_OPTIONS)
export class PresenceGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(PresenceGateway.name);
  private readonly enabled: boolean;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly presence: PresenceService,
    private readonly scopes: CommerceScopeService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('ADMIN_PRESENCE_ENABLED') !== 'false';
  }

  handleConnection(client: Socket): void {
    const admin = this.dataOf(client).admin;
    if (!admin) {
      client.disconnect(true);
      return;
    }
    if (!this.enabled) return;
    void this.ensureScope(client, admin).catch(() => client.disconnect(true));
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const data = this.dataOf(client);
    if (!this.enabled || !data.admin || !data.scopeP || !data.rooms) return;

    let scope: string;
    try {
      scope = await data.scopeP;
    } catch {
      return;
    }

    for (const room of data.rooms) {
      const ref = this.presence.parseRoom(room);
      if (!ref) continue;
      try {
        await this.presence.removeAdmin(scope, room, data.admin.id);
        const snapshot = await this.presence.snapshot(
          scope,
          ref.channel,
          ref.conversationId,
        );
        this.broadcast(scope, snapshot);
      } catch (error) {
        this.logger.warn(`presence cleanup failed: ${String(error)}`);
      }
    }
    data.rooms.clear();
  }

  @SubscribeMessage('presence:sync')
  sync(@ConnectedSocket() client: Socket) {
    return this.run<{ rooms: PresenceRoom[] }>(client, async (scope) => ({
      ok: true,
      rooms: await this.presence.snapshotAll(scope),
    }));
  }

  @SubscribeMessage('presence:join')
  join(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return this.run<{ room: PresenceRoom }>(client, async (scope, admin) => {
      const parsed = roomRefSchema.safeParse(body);
      if (!parsed.success) return { ok: false, reason: 'INVALID_PAYLOAD' };
      const { channel, conversationId } = parsed.data;
      const room = this.presence.roomKey(channel, conversationId);

      const joined = this.roomsOf(client);
      if (!joined.has(room) && joined.size >= MAX_ROOMS_PER_SOCKET) {
        return { ok: false, reason: 'TOO_MANY_ROOMS' };
      }
      if (!(await this.conversationExists(scope, channel, conversationId))) {
        return { ok: false, reason: 'NOT_FOUND' };
      }

      await this.presence.touchView(scope, room, {
        id: admin.id,
        name: this.displayName(admin),
      });
      joined.add(room);
      // A disconnect during the awaits ran before this room was recorded, so
      // undo the view here instead of leaving it to expire.
      if (client.disconnected) {
        await this.presence.removeAdmin(scope, room, admin.id);
        return { ok: false, reason: 'UNAVAILABLE' };
      }

      const snapshot = await this.presence.snapshot(
        scope,
        channel,
        conversationId,
      );
      this.broadcast(scope, snapshot);
      return { ok: true, room: snapshot };
    });
  }

  @SubscribeMessage('presence:leave')
  leave(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return this.run<object>(client, async (scope, admin) => {
      const parsed = roomRefSchema.safeParse(body);
      if (!parsed.success) return { ok: false, reason: 'INVALID_PAYLOAD' };
      const { channel, conversationId } = parsed.data;
      const room = this.presence.roomKey(channel, conversationId);

      const joined = this.roomsOf(client);
      if (!joined.has(room)) return { ok: true };

      await this.presence.removeAdmin(scope, room, admin.id);
      joined.delete(room);
      this.typingAtOf(client).delete(room);
      const snapshot = await this.presence.snapshot(
        scope,
        channel,
        conversationId,
      );
      this.broadcast(scope, snapshot);
      return { ok: true };
    });
  }

  @SubscribeMessage('presence:heartbeat')
  heartbeat(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return this.run<{ room: PresenceRoom }>(client, async (scope, admin) => {
      const parsed = roomRefSchema.safeParse(body);
      if (!parsed.success) return { ok: false, reason: 'INVALID_PAYLOAD' };
      const { channel, conversationId } = parsed.data;
      const room = this.presence.roomKey(channel, conversationId);

      if (!this.roomsOf(client).has(room)) {
        return { ok: false, reason: 'NOT_JOINED' };
      }
      const { added } = await this.presence.touchView(scope, room, {
        id: admin.id,
        name: this.displayName(admin),
      });
      const snapshot = await this.presence.snapshot(
        scope,
        channel,
        conversationId,
      );
      // Only a new viewer changes what others see; plain renewals stay quiet.
      if (added) this.broadcast(scope, snapshot);
      return { ok: true, room: snapshot };
    });
  }

  @SubscribeMessage('presence:typing')
  typing(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return this.run<object>(client, async (scope, admin) => {
      const parsed = typingSchema.safeParse(body);
      if (!parsed.success) return { ok: false, reason: 'INVALID_PAYLOAD' };
      const { channel, conversationId, typing } = parsed.data;
      const room = this.presence.roomKey(channel, conversationId);

      if (!this.roomsOf(client).has(room)) {
        return { ok: false, reason: 'NOT_JOINED' };
      }
      const typingAt = this.typingAtOf(client);
      const now = Date.now();
      const last = typingAt.get(room);
      if (typing && last !== undefined && now - last < TYPING_MIN_INTERVAL_MS) {
        return { ok: true };
      }

      await this.presence.setTyping(scope, room, admin.id, typing);
      // Stopping must reset the throttle, or typing again within the interval
      // would be dropped and the indicator would lag until the next resend.
      if (typing) typingAt.set(room, now);
      else typingAt.delete(room);
      const snapshot = await this.presence.snapshot(
        scope,
        channel,
        conversationId,
      );
      this.broadcast(scope, snapshot);
      return { ok: true };
    });
  }

  /** Shared guard for every handler: feature flag, authenticated admin, scope,
   *  and a catch-all so a Redis or DB failure becomes an ack, not a crash. */
  private async run<T extends object = object>(
    client: Socket,
    action: (
      scope: string,
      admin: AuthenticatedAdmin,
    ) => Promise<PresenceAck<T>>,
  ): Promise<PresenceAck<T>> {
    if (!this.enabled) return this.failure('DISABLED');

    const admin = this.dataOf(client).admin;
    if (!admin) {
      client.disconnect(true);
      return this.failure('UNAUTHORIZED');
    }

    let scope: string;
    try {
      scope = await this.ensureScope(client, admin);
    } catch {
      client.disconnect(true);
      return this.failure('UNAUTHORIZED');
    }

    try {
      return await action(scope, admin);
    } catch (error) {
      this.logger.warn(`presence request failed: ${String(error)}`);
      return this.failure('UNAVAILABLE');
    }
  }

  private failure(reason: PresenceFailure): {
    ok: false;
    reason: PresenceFailure;
  } {
    return { ok: false, reason };
  }

  /** Resolved once per socket. Joining the scope room here means every
   *  broadcast after this point reaches this socket. */
  private ensureScope(
    client: Socket,
    admin: AuthenticatedAdmin,
  ): Promise<string> {
    const data = this.dataOf(client);
    data.scopeP ??= this.scopes.forAdmin(admin).then(async (scope) => {
      await client.join(scopeRoom(scope.companyId));
      return scope.companyId;
    });
    return data.scopeP;
  }

  private broadcast(scope: string, room: PresenceRoom): void {
    this.server.to(scopeRoom(scope)).emit('presence:update', room);
  }

  private async conversationExists(
    scope: string,
    channel: PresenceChannel,
    conversationId: string,
  ): Promise<boolean> {
    if (CHANNEL_KINDS[channel].store === 'line') {
      const row = await this.prisma.lineConversation.findUnique({
        where: { id: conversationId },
        select: { id: true },
      });
      return row !== null;
    }
    if (!isStoredChannelKind(channel)) return false;
    const row = await this.prisma.channelConversation.findFirst({
      where: { id: conversationId, channel, companyId: scope },
      select: { id: true },
    });
    return row !== null;
  }

  private displayName(admin: AuthenticatedAdmin): string {
    return `${admin.firstName} ${admin.lastName}`.trim() || admin.username;
  }

  private dataOf(client: Socket): PresenceSocketData {
    return client.data as PresenceSocketData;
  }

  private roomsOf(client: Socket): Set<string> {
    const data = this.dataOf(client);
    data.rooms ??= new Set();
    return data.rooms;
  }

  private typingAtOf(client: Socket): Map<string, number> {
    const data = this.dataOf(client);
    data.typingAt ??= new Map();
    return data.typingAt;
  }
}
