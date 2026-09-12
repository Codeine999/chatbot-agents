import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { LineRichMenuClient } from './line-rich-menu.client';
import { RichMenuController } from './rich-menu.controller';
import { RichMenuService } from './rich-menu.service';

@Module({
  imports: [PrismaModule],
  controllers: [RichMenuController],
  providers: [RichMenuService, LineRichMenuClient],
  exports: [RichMenuService, LineRichMenuClient],
})
export class RichMenuModule {}
