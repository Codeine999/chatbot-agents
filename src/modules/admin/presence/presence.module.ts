import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { CommerceAccessModule } from '../../commerce/commerce-access.module';
import { PresenceGateway } from './presence.gateway';
import { PresenceService } from './presence.service';

@Module({
  imports: [PrismaModule, CommerceAccessModule],
  providers: [PresenceService, PresenceGateway],
})
export class PresenceModule {}
