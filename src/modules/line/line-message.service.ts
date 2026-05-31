import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class LineMessageService {
  private readonly client: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    this.client = axios.create({
      baseURL: 'https://api.line.me/v2/bot',
      headers: {
        Authorization: `Bearer ${this.configService.getOrThrow<string>(
          'LINE_CHANNEL_ACCESS_TOKEN',
        )}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async replyText(replyToken: string, text: string): Promise<void> {
    await this.client.post('/message/reply', {
      replyToken,
      messages: [
        {
          type: 'text',
          text,
        },
      ],
    });
  }

  async pushText(userId: string, text: string): Promise<void> {
    await this.client.post('/message/push', {
      to: userId,
      messages: [
        {
          type: 'text',
          text,
        },
      ],
    });
  }
}
