import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SwaggerTheme, SwaggerThemeNameEnum } from 'swagger-themes';
import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import fastifyRawBody from 'fastify-raw-body';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { ADMIN_PROFILE_IMAGE_MAX_BYTES } from './modules/admin/constants/admin-upload.constants';


async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Multipart files are limited to 5MB below; leave room for form fields
      // and MIME boundaries so Fastify does not reject them at its 1MB default.
      bodyLimit: ADMIN_PROFILE_IMAGE_MAX_BYTES + 1024 * 1024,
    }),
  );

  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    runFirst: true,
    routes: ['/api/line/webhooks'],
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: ADMIN_PROFILE_IMAGE_MAX_BYTES,
      files: 1,
    },
  });

  await app.register(fastifyStatic, {
    root: join(process.cwd(), 'uploads'),
    prefix: '/uploads/',
  });

  const configService = app.get(ConfigService);

  app.enableCors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        'http://localhost:5173',
        'https://chatbot-dashboard-r6ac.vercel.app',
        'http://localhost:8080'
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
  const theme = new SwaggerTheme();
  const nordDarkCss = theme
    .getBuffer(SwaggerThemeNameEnum.NORD_DARK)
    .toString()
    .replace(/^\s*@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*/, '')
    .replace(/\s*}\s*$/, '');

  SwaggerModule.setup('docs', app, cleanupOpenApiDoc(document), {
    customCss: nordDarkCss,
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
