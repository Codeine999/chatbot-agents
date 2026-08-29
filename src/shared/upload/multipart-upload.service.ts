import { BadRequestException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ZodValidationException } from 'nestjs-zod';
import type { z } from 'zod';
import type {
  MultipartPayload,
  ParseMultipartOptions,
  StoreUploadOptions,
  UploadedFile,
} from './multipart-upload.types';

@Injectable()
export class MultipartUploadService {
  async parseDto<TOutput>(
    request: FastifyRequest,
    schema: z.ZodType<TOutput>,
    options: ParseMultipartOptions,
  ): Promise<TOutput> {
    const multipart = await this.parse(request, options);
    return this.validate(schema, this.toDtoPayload(multipart));
  }

  async parse(
    request: FastifyRequest,
    options: ParseMultipartOptions,
  ): Promise<MultipartPayload> {
    if (!request.isMultipart()) {
      throw new BadRequestException(
        options.notMultipartMessage ?? 'Multipart form data is required',
      );
    }

    const maxFiles = options.maxFiles ?? 1;
    const maxFields = options.maxFields ?? 20;
    const fields = new Map<string, string>();
    const files = new Map<string, UploadedFile>();

    try {
      for await (const part of request.parts({
        limits: {
          files: maxFiles,
          fields: maxFields,
          parts: maxFiles + maxFields,
          fileSize: options.maxFileSize,
        },
      })) {
        if (fields.has(part.fieldname) || files.has(part.fieldname)) {
          throw new BadRequestException(
            `Multipart field "${part.fieldname}" must only be sent once`,
          );
        }

        if (part.type === 'field') {
          if (part.valueTruncated) {
            throw new BadRequestException(
              `Multipart field "${part.fieldname}" is too large`,
            );
          }

          fields.set(part.fieldname, String(part.value).trim());
          continue;
        }

        const buffer = await part.toBuffer();
        if (part.file.truncated) {
          throw new BadRequestException(
            `File "${part.filename}" exceeds the upload size limit`,
          );
        }

        files.set(part.fieldname, {
          fieldname: part.fieldname,
          filename: part.filename,
          encoding: part.encoding,
          mimetype: part.mimetype,
          size: buffer.length,
          buffer,
        });
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        options.invalidMultipartMessage ?? 'Invalid multipart form data',
      );
    }

    return { fields, files };
  }

  toDtoPayload(payload: MultipartPayload): Record<string, unknown> {
    const entries: Array<[string, unknown]> = [];
    entries.push(...payload.fields, ...payload.files);
    return Object.fromEntries(entries);
  }

  validate<TOutput>(schema: z.ZodType<TOutput>, value: unknown): TOutput {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new ZodValidationException(result.error);
    }

    return result.data;
  }

  async store(
    file: UploadedFile,
    options: StoreUploadOptions,
  ): Promise<string> {
    const extension = options.mimeToExtension[file.mimetype];
    if (!extension) {
      throw new BadRequestException('Unsupported upload type');
    }

    await mkdir(options.uploadDirectory, { recursive: true });

    const filename = `${randomUUID()}${extension}`;
    await writeFile(join(options.uploadDirectory, filename), file.buffer);

    return `${options.publicUrlPrefix}/${filename}`;
  }

  async delete(
    publicPath: string | null | undefined,
    options: StoreUploadOptions,
  ): Promise<void> {
    if (!publicPath?.startsWith(`${options.publicUrlPrefix}/`)) return;

    const filename = publicPath.slice(options.publicUrlPrefix.length + 1);
    if (!filename || basename(filename) !== filename) return;

    try {
      await unlink(join(options.uploadDirectory, filename));
    } catch {
      // Best-effort cleanup; a missing file is not an error.
    }
  }
}
