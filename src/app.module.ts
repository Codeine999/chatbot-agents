import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { LineModule } from './modules/line/line.module';
import { RegistrationModule } from './modules/registration/registration.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './modules/users/users.module';
import { PaymentsModule } from './modules/payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    PrismaModule,

    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.getOrThrow<string>('MONGO_URI'),
      }),
    }),

    LineModule,

    RegistrationModule,

    PipelineModule,

    UsersModule,

    PaymentsModule,
  ],
})
export class AppModule {}
