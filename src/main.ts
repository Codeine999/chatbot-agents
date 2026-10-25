import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SwaggerTheme, SwaggerThemeNameEnum } from 'swagger-themes';
import { Logger } from '@nestjs/common';
import type { FastifyCorsOptions } from '@fastify/cors';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import fastifyRawBody from 'fastify-raw-body';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { ADMIN_PROFILE_IMAGE_MAX_BYTES } from './modules/admin/constants/admin-upload.constants';
import { AppLogger } from './infra/logging/app-logger';
import {
  APP_BODY_LIMIT_BYTES,
  AppMessageConfig,
} from './modules/app-message/app-message.config';
import {
  LOCAL_UPLOAD_ROOT,
  LOCAL_UPLOAD_URL_PREFIX,
} from './infra/storage/local-object-storage.adapter';

const APP_API_PREFIX = '/api/app/';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Multipart files are limited to 5MB below; leave room for form fields
      // and MIME boundaries so Fastify does not reject them at its 1MB default.
      bodyLimit: ADMIN_PROFILE_IMAGE_MAX_BYTES + 1024 * 1024,
      // Number of proxies in front of the app (production: nginx = 1). Never
      // `true`: that would trust a client-supplied X-Forwarded-For.
      trustProxy: Number(process.env.TRUST_PROXY_HOPS ?? 0),
    }),
    { logger: new AppLogger({ timestamp: true }) },
  );

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url.startsWith(APP_API_PREFIX))
        route.bodyLimit = APP_BODY_LIMIT_BYTES;
    });

  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    runFirst: true,
    routes: ['/api/line/webhooks', '/api/line/webhooks/:channelKey'],
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: ADMIN_PROFILE_IMAGE_MAX_BYTES,
      files: 1,
    },
  });

  // Local-driver uploads and every file stored before R2 keep being served here.
  await app.register(fastifyStatic, {
    root: LOCAL_UPLOAD_ROOT,
    prefix: `${LOCAL_UPLOAD_URL_PREFIX}/`,
  });

  const configService = app.get(ConfigService);

  const dashboardCors: FastifyCorsOptions = {
    origin: (origin, callback) => {
      const allowedOrigins = [
        'http://localhost:5173',
        'http://45.144.164.231',
        'https://keela-agent.online',
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
      'Idempotency-Key',
      'ngrok-skip-browser-warning',
    ],
    credentials: true,
  };

  const appOrigins = app.get(AppMessageConfig).values.allowedOrigins;
  const appCors: FastifyCorsOptions = {
    origin: (origin, done) =>
      done(null, !origin || appOrigins.includes(origin)),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  };
  app.enableCors({
    delegator: (request: FastifyRequest, callback) =>
      callback(
        null,
        request.url.startsWith(APP_API_PREFIX) ? appCors : dashboardCors,
      ),
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

  const port = configService.get<number>('PORT') || 8080;

  await app.listen(port, '0.0.0.0');
  Logger.log(`Server running on ${port}`);
}

bootstrap();
