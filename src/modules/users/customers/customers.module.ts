import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { CustomerIdentityService } from './customer-identity.service';
import { AccountLinkService } from './account-link.service';

@Module({
  imports: [PrismaModule],
  providers: [CustomerIdentityService, AccountLinkService],
  exports: [CustomerIdentityService, AccountLinkService],
})
export class CustomersModule {}
