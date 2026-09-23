import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AdminRole,
  AuthenticatedAdmin,
} from '../../shared/guards/admin-auth.types';
import {
  ADMIN_PROFILE_IMAGE_ALLOWED_EXTENSIONS,
  ADMIN_PROFILE_IMAGE_MAX_BYTES,
  ADMIN_PROFILE_IMAGE_MIME_TO_EXTENSION,
  ADMIN_UPLOAD_URL_PREFIX,
} from './constants/admin-upload.constants';
import type { UpdateAdminDto } from './dto/update-admin.dto';

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

  /**
   * Lists admins in one company only. A null companyId is the legacy scope and
   * matches only unscoped admins, never every company.
   */
  async getAllAdmin(companyId: string | null) {
    const admins = await this.prisma.adminMember.findMany({
      where: { companyId },
      select: { ...ADMIN_PUBLIC_SELECT, aiEnabled: true, createdAt: true },
      orderBy: { username: 'asc' },
    });

    return admins.map(({ firstname, lastname, ...admin }) => ({
      ...admin,
      firstName: firstname,
      lastName: lastname,
    }));
  }

  /**
   * Devs manage every account; owners manage `admin` accounts only, matching
   * the AI-access rule. Nobody can change their own role, and no one is
   * promoted to `dev` from the console.
   */
  async updateAdmin(
    actor: AuthenticatedAdmin,
    targetId: string,
    input: UpdateAdminDto,
  ) {
    const target = await this.findManageableAdmin(actor, targetId, {
      allowSelf: true,
    });

    if (input.role !== undefined && input.role !== target.role) {
      if (target.id === actor.id) {
        throw new ForbiddenException('You cannot change your own role');
      }
      this.assertCanAssignRole(actor, input.role);
    }

    const password =
      input.password === undefined
        ? undefined
        : await bcrypt.hash(input.password, 12);

    try {
      const { firstname, lastname, ...updated } =
        await this.prisma.adminMember.update({
          where: { id: target.id },
          data: {
            username: input.username,
            password,
            firstname: input.firstName,
            lastname: input.lastName,
            email: input.email?.toLowerCase(),
            phone: input.phone,
            image: input.image,
            role: input.role,
            aiEnabled: input.aiEnabled,
          },
          select: { ...ADMIN_PUBLIC_SELECT, aiEnabled: true, createdAt: true },
        });

      if (input.image !== undefined && input.image !== target.image) {
        await this.deleteStoredImage(target.image);
      }

      return { ...updated, firstName: firstname, lastName: lastname };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Admin username, email, or phone exists');
      }
      throw error;
    }
  }

  /**
   * Hard delete. The admin's back-office chat rooms cascade away; usage events,
   * LINE messages, and rich menus keep their rows with the admin link nulled.
   */
  async deleteAdmin(
    actor: AuthenticatedAdmin,
    targetId: string,
  ): Promise<{ deleted: true }> {
    const target = await this.findManageableAdmin(actor, targetId, {
      allowSelf: false,
    });

    try {
      await this.prisma.adminMember.delete({ where: { id: target.id } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        // CreditTopupHistory.requestedBy is required and keeps top-up history.
        throw new ConflictException(
          'Admin has credit top-up history and cannot be deleted',
        );
      }
      throw error;
    }

    await this.deleteStoredImage(target.image);
    return { deleted: true };
  }

  /** 404 for another company's admin, so ids outside the scope stay opaque. */
  private async findManageableAdmin(
    actor: AuthenticatedAdmin,
    targetId: string,
    options: { allowSelf: boolean },
  ) {
    const target = await this.prisma.adminMember.findFirst({
      where: { id: targetId, companyId: actor.companyId },
      select: { id: true, role: true, image: true },
    });

    if (!target) {
      throw new NotFoundException('Admin not found');
    }

    if (target.id === actor.id) {
      if (!options.allowSelf) {
        throw new ForbiddenException('You cannot delete your own account');
      }
      return target;
    }

    if (actor.role === 'owner' && target.role !== 'admin') {
      throw new ForbiddenException('Owners can manage admin accounts only');
    }

    return target;
  }

  private assertCanAssignRole(actor: AuthenticatedAdmin, role: AdminRole) {
    if (role === 'dev') {
      throw new BadRequestException('Can not assign the dev role');
    }
    if (actor.role === 'owner' && role !== 'admin') {
      throw new ForbiddenException('Owners can assign the admin role only');
    }
  }

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
