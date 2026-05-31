import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageAnalyzerService } from '../chatbot/message-analyzer.service';
import { RegistrationService } from '../registration/registration.service';
import { LineMessageService } from './line-message.service';

interface LineWebhookBody {
  events?: LineWebhookEvent[];
}

interface LineWebhookEvent {
  type?: string;
  replyToken?: string;
  source?: {
    userId?: string;
  };
  message?: {
    type?: string;
    text?: string;
  };
}

interface HandleWebhookInput {
  body: LineWebhookBody;
  signature?: string;
  rawBody?: string | Buffer;
}

@Injectable()
export class LineWebhookService {
  private readonly logger = new Logger(LineWebhookService.name);


}
