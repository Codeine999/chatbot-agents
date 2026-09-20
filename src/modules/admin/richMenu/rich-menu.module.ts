import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { ChatbotModule } from '../../chatbot/chatbot.module';
import { LineRichMenuClient } from './line-rich-menu.client';
import { RichMenuController } from './rich-menu.controller';
import { RichMenuImageService } from './rich-menu-image.service';
import { RichMenuReplyController } from './rich-menu-reply.controller';
import { RichMenuReplyService } from './rich-menu-reply.service';
import { RichMenuService } from './rich-menu.service';

@Module({
  // ChatbotModule owns the cache the bot answers taps from; writing a reply
  // here has to reload it so a freshly published button works right away.
  imports: [PrismaModule, ChatbotModule],
  controllers: [RichMenuController, RichMenuReplyController],
  providers: [
    RichMenuService,
    RichMenuReplyService,
    RichMenuImageService,
    LineRichMenuClient,
  ],
  exports: [RichMenuService, RichMenuReplyService, LineRichMenuClient],
})
export class RichMenuModule {}
