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
import fastifyRawBody from 'fastify-raw-body';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // Raw body is only needed on the LINE webhook route, where the
  // signature is an HMAC of the exact bytes LINE sent. Keeping the
  // default utf8 encoding avoids replacing the JSON content-type
  // parser that the Nest Fastify adapter already registered.
  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    runFirst: true,
    routes: ['/api/line/webhooks'],
  });

  const configService = app.get(ConfigService);

  app.enableCors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        'http://localhost:5173',
        'https://chatbot-dashboard-r6ac.vercel.app',
      ];

      const isVercelPreview =
        origin?.startsWith('https://chatbot-dashboard-r6ac-') &&
        origin.endsWith('-codeines-projects-0adf5d1d.vercel.app');

      if (!origin || allowedOrigins.includes(origin) || isVercelPreview) {
        callback(null, true);
        return;
      }

      callback(new Error(`Not allowed by CORS: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'ngrok-skip-browser-warning',
    ],
    credentials: true,
  });

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
