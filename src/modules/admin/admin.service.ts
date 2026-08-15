import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ADMIN_PROFILE_IMAGE_ALLOWED_EXTENSIONS,
  ADMIN_PROFILE_IMAGE_MAX_BYTES,
  ADMIN_PROFILE_IMAGE_MIME_TO_EXTENSION,
  ADMIN_UPLOAD_URL_PREFIX,
} from './constants/admin-upload.constants';

const ADMIN_UPLOAD_DIR = join(process.cwd(), 'uploads', 'admin');

const ADMIN_PUBLIC_SELECT = {
  id: true,
  username: true,
  firstname: true,
  lastname: true,
  email: true,
  phone: true,
  image: true,
  role: true,
} as const;

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async uploadProfileImage(adminId: string, request: FastifyRequest) {
    const admin = await this.prisma.adminMember.findUnique({
      where: { id: adminId },
      select: { id: true, image: true },
    });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    let file: Awaited<ReturnType<FastifyRequest['file']>>;

    try {
      file = await request.file({
        limits: { fileSize: ADMIN_PROFILE_IMAGE_MAX_BYTES, files: 1 },
      });
    } catch {
      throw new BadRequestException('Invalid multipart upload');
    }

    if (!file) {
      throw new BadRequestException('No image file was uploaded');
    }

    const clientExtension = extname(file.filename).toLowerCase();
    if (
      !ADMIN_PROFILE_IMAGE_ALLOWED_EXTENSIONS.includes(
        clientExtension as (typeof ADMIN_PROFILE_IMAGE_ALLOWED_EXTENSIONS)[number],
      )
    ) {
      throw new BadRequestException(
        `Unsupported file extension. Allowed: ${ADMIN_PROFILE_IMAGE_ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }

    const extension = ADMIN_PROFILE_IMAGE_MIME_TO_EXTENSION[file.mimetype];
    if (!extension) {
      throw new BadRequestException(
        `Unsupported image type. Allowed: ${Object.keys(
          ADMIN_PROFILE_IMAGE_MIME_TO_EXTENSION,
        ).join(', ')}`,
      );
    }

    const buffer = await file.toBuffer();

    if (file.file.truncated) {
      throw new BadRequestException(
        `Image exceeds the ${ADMIN_PROFILE_IMAGE_MAX_BYTES / (1024 * 1024)}MB limit`,
      );
    }

    await mkdir(ADMIN_UPLOAD_DIR, { recursive: true });

    const filename = `${randomUUID()}${extension}`;
    const filePath = join(ADMIN_UPLOAD_DIR, filename);
    await writeFile(filePath, buffer);

    const publicPath = `${ADMIN_UPLOAD_URL_PREFIX}/${filename}`;

    const { firstname, lastname, ...updated } =
      await this.prisma.adminMember.update({
        where: { id: adminId },
        data: { image: publicPath },
        select: ADMIN_PUBLIC_SELECT,
      });

    await this.deleteStoredImage(admin.image);

    return {
      ...updated,
      firstName: firstname,
      lastName: lastname,
    };
  }

  private async deleteStoredImage(imagePath: string | null): Promise<void> {
    if (!imagePath?.startsWith(`${ADMIN_UPLOAD_URL_PREFIX}/`)) return;

    const filename = imagePath.slice(ADMIN_UPLOAD_URL_PREFIX.length + 1);
    try {
      await unlink(join(ADMIN_UPLOAD_DIR, filename));
    } catch {
      // best-effort cleanup; a missing file is not an error
    }
  }
}
