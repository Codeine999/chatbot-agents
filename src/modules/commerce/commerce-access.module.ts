import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { CommerceFeatureService } from './commerce-feature.service';
import { CommerceScopeService } from './commerce-scope.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [CommerceFeatureService, CommerceScopeService],
  exports: [CommerceFeatureService, CommerceScopeService],
})
export class CommerceAccessModule {}
