import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AdminJwtService } from '../auth/admin-jwt.service';
import type { AdminNotification } from './types/notification.type';

@WebSocketGateway({
  namespace: 'admin',
  cors: {
    origin: '*',
  },
})
export class NotificationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly adminJwtService: AdminJwtService) {}

  afterInit(server: Server) {
    server.use((client, next) => {
      void this.authorizeConnection(client, next);
    });
  }

  handleConnection(client: Socket) {
    this.logger.debug(`admin client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`admin client disconnected: ${client.id}`);
  }

  /** Broadcasts to every connected admin socket — there is no per-admin targeting. */
  emitAdminNotification(notification: AdminNotification) {
    this.server.emit('ADMIN_NOTIFICATION', notification);
  }

  private async authorizeConnection(
    client: Socket,
    next: (error?: Error) => void,
  ): Promise<void> {
    const auth = client.handshake.auth as Record<string, unknown>;
    const authorization = client.handshake.headers.authorization;
    const presentedToken =
      typeof auth?.token === 'string' && auth.token.length > 0
        ? auth.token
        : typeof authorization === 'string' &&
            authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : undefined;

    try {
      const admin = presentedToken
        ? await this.adminJwtService.authenticate(presentedToken)
        : null;

      if (!admin) {
        this.logger.warn(
          `rejected unauthorized admin socket connection: ${client.id}`,
        );
        next(new Error('unauthorized'));
        return;
      }

      next();
    } catch {
      next(new Error('unauthorized'));
    }
  }
}
