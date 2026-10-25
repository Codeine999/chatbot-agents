import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../prisma/prisma.module';
import { CommerceAccessModule } from '../../commerce/commerce-access.module';
import { LineChannelAdminController } from './line-channel-admin.controller';
import { LineChannelAdminService } from './line-channel-admin.service';
import { LineCredentialService } from './line-credential.service';
import { LineWebhookHealthController } from './line-webhook-health.controller';
import { LineWebhookHealthService } from './line-webhook-health.service';

@Module({
  imports: [ConfigModule, PrismaModule, CommerceAccessModule],
  controllers: [LineChannelAdminController, LineWebhookHealthController],
  providers: [
    LineCredentialService,
    LineChannelAdminService,
    LineWebhookHealthService,
  ],
  exports: [LineCredentialService],
})
export class LineChannelModule {}
