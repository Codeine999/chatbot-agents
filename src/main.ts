import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  const configService = app.get(ConfigService);

  app.useGlobalPipes(new ZodValidationPipe());

  const config = new DocumentBuilder()
    .setTitle('Chatbot API')
    .setDescription('Chatbot API documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, cleanupOpenApiDoc(document), {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  const mongoConnection = app.get<Connection>(getConnectionToken());

  await mongoConnection.asPromise();

  Logger.log(`MongoDB connected: ${mongoConnection.name}`, 'Bootstrap');

  mongoConnection.on('error', (error) => {
    Logger.error('MongoDB connection error', error, 'Bootstrap');
  });

  mongoConnection.on('disconnected', () => {
    Logger.warn('MongoDB disconnected', 'Bootstrap');
  });

  const port = configService.get<number>('PORT') || 8080;

  await app.listen(8080, '0.0.0.0');
  Logger.log(`Server running on ${port}`);

}

bootstrap();