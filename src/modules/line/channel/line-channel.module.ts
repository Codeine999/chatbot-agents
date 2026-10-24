import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../prisma/prisma.module';
import { CommerceAccessModule } from '../../commerce/commerce-access.module';
import { LineChannelAdminController } from './line-channel-admin.controller';
import { LineChannelAdminService } from './line-channel-admin.service';
import { LineCredentialService } from './line-credential.service';

@Module({
  imports: [ConfigModule, PrismaModule, CommerceAccessModule],
  controllers: [LineChannelAdminController],
  providers: [LineCredentialService, LineChannelAdminService],
  exports: [LineCredentialService],
})
export class LineChannelModule {}
