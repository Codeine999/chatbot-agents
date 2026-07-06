import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ConversationSession } from '../../chatbot/user-session.service';

@WebSocketGateway({
  namespace: 'admin',
  cors: {
    origin: '*',
  },
})
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    this.logger.debug(`admin client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`admin client disconnected: ${client.id}`);
  }

  emitContactAdmin(session: ConversationSession) {
    this.server.emit('CONTACT_ADMIN', session);
  }
}
