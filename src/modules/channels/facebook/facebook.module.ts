import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../prisma/prisma.module';
import { CompanyModule } from '../../admin/company/company.module';
import { CommerceAccessModule } from '../../commerce/commerce-access.module';
import { ChannelGatewayModule } from '../core/channel-gateway.module';
import { FacebookChannelAdminController } from './admin/facebook-channel-admin.controller';
import { FacebookChannelAdminService } from './admin/facebook-channel-admin.service';
import { FacebookConfig } from './facebook.config';
import { FacebookConnector } from './facebook.connector';
import { FacebookCredentialService } from './facebook-credential.service';

/**
 * Facebook Messenger connector. Webhook:
 * /api/channels/facebook/webhooks/:channelKey (one URL per connected Page;
 * the bare URL serves the legacy FACEBOOK_* Page). Pages are connected by
 * company admins through /api/admin/facebook/channel.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CompanyModule,
    CommerceAccessModule,
    ChannelGatewayModule,
  ],
  controllers: [FacebookChannelAdminController],
  providers: [
    FacebookConfig,
    FacebookCredentialService,
    FacebookChannelAdminService,
    FacebookConnector,
  ],
})
export class FacebookModule {}
