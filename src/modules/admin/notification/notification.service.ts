import { Injectable, Logger } from '@nestjs/common';
import { ConversationSession } from '../../chatbot/user-session.service';
import { NotificationGateway } from './notification.gateway';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly notificationGateway: NotificationGateway) {}

  notifyContactAdmin(session: ConversationSession) {
    this.logger.debug(
      `notify admin: userId=${session.userId} flow=${session.flow} step=${session.step}`,
    );

    this.notificationGateway.emitContactAdmin(session);
  }
}
