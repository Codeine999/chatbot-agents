import { Module } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { CustomersModule } from '../users/customers/customers.module';
import { CommerceAccessModule } from '../commerce/commerce-access.module';

@Module({
  imports: [PrismaModule, CustomersModule, CommerceAccessModule],
  controllers: [RegistrationController],
  providers: [RegistrationService],
  exports: [RegistrationService],
})
export class RegistrationModule {}
