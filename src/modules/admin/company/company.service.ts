import {
  BadRequestException,
  InternalServerErrorException,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { extname } from 'node:path';
import { PrismaService } from '../../../prisma/prisma.service';
import { Company } from '../../../generated/prisma/client';
import { FileStorageService } from '../../../infra/storage/file-storage.service';
import {
  COMPANY_IMAGE_ALLOWED_EXTENSIONS,
  COMPANY_IMAGE_MAX_BYTES,
  COMPANY_IMAGE_MIME_TO_EXTENSION,
  COMPANY_UPLOAD_FOLDER,
} from './company-upload.constants';
import type { UpdateCompanyDto } from './dto/update-company.dto';

export type FollowerChange = {
  changePercent: number | null;
  sinceDate: string | null;
};

@Injectable()
export class CompanyService {
  private companyId?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileStorage: FileStorageService,
  ) {}

  async getCompanyId(): Promise<string> {
    if (this.companyId) return this.companyId;

    const company = await this.getOrCreate();
    this.companyId = company.id;
    return company.id;
  }

  /** Full singleton company record for brand settings in the back office. */
  async getBrandInfo(): Promise<Company> {
    return this.getOrCreate();
  }

  async addCompany(request: FastifyRequest) {
    if (!request.isMultipart()) {
      throw new BadRequestException(
        'Company name, company type, and image are required',
      );
    }

    let companyName = '';
    let companyType = '';
    let imageBuffer: Buffer | undefined;
    let imageExtension = '';
    let imageMimeType = '';

    try {
      for await (const part of request.parts({
        limits: {
          files: 1,
          fileSize: COMPANY_IMAGE_MAX_BYTES,
        },
      })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'image' || imageBuffer) {
            throw new BadRequestException(
              'Only one image file is allowed in the image field',
            );
          }

          const clientExtension = extname(part.filename).toLowerCase();
          if (
            !COMPANY_IMAGE_ALLOWED_EXTENSIONS.includes(
              clientExtension as (typeof COMPANY_IMAGE_ALLOWED_EXTENSIONS)[number],
            )
          ) {
            throw new BadRequestException(
              `Unsupported image extension. Allowed: ${COMPANY_IMAGE_ALLOWED_EXTENSIONS.join(', ')}`,
            );
          }

          imageExtension = COMPANY_IMAGE_MIME_TO_EXTENSION[part.mimetype];
          if (!imageExtension) {
            throw new BadRequestException(
              `Unsupported image type. Allowed: ${Object.keys(
                COMPANY_IMAGE_MIME_TO_EXTENSION,
              ).join(', ')}`,
            );
          }

          imageMimeType = part.mimetype;
          imageBuffer = await part.toBuffer();

          if (part.file.truncated) {
            throw new BadRequestException(
              `Image exceeds the ${COMPANY_IMAGE_MAX_BYTES / (1024 * 1024)}MB limit`,
            );
          }

          continue;
        }

        if (part.fieldname === 'companyName') {
          companyName = String(part.value).trim();
        } else if (part.fieldname === 'companyType') {
          companyType = String(part.value).trim();
        }
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Invalid multipart company data');
    }

    if (!companyName || !companyType || !imageBuffer || !imageExtension) {
      throw new BadRequestException(
        'Company name, company type, and image are required',
      );
    }

    const imagePath = await this.fileStorage.upload({
      visibility: 'public',
      folder: COMPANY_UPLOAD_FOLDER,
      body: imageBuffer,
      contentType: imageMimeType,
      extension: imageExtension,
    });

    const existing = await this.prisma.company.findFirst();

    try {
      const company = existing
        ? await this.prisma.company.update({
            where: { id: existing.id },
            data: {
              name: companyName,
              companyType,
              image: imagePath,
            },
          })
        : await this.prisma.company.create({
            data: {
              name: companyName,
              companyType,
              image: imagePath,
            },
          });

      this.companyId = company.id;

      if (existing?.image) {
        await this.deleteStoredImage(existing.image);
      }

      return company;
    } catch (error) {
      await this.deleteStoredImage(imagePath);
      throw error instanceof Error
        ? error
        : new InternalServerErrorException('Failed to save company');
    }
  }

  /**
   * Partial brand edit: only the fields sent change. A new image is stored
   * before the row is updated and the old one is deleted only afterwards, so a
   * failed update never leaves the company pointing at a missing logo.
   */
  async updateCompany(dto: UpdateCompanyDto): Promise<Company> {
    const existing = await this.getOrCreate();

    const imagePath = dto.image
      ? await this.fileStorage.upload({
          visibility: 'public',
          folder: COMPANY_UPLOAD_FOLDER,
          body: dto.image.buffer,
          contentType: dto.image.mimetype,
          extension: COMPANY_IMAGE_MIME_TO_EXTENSION[dto.image.mimetype],
        })
      : undefined;

    const company = await this.prisma.company
      .update({
        where: { id: existing.id },
        data: { name: dto.name, image: imagePath },
      })
      .catch(async (error: unknown) => {
        if (imagePath) await this.deleteStoredImage(imagePath);
        throw error;
      });

    if (imagePath && existing.image) {
      await this.deleteStoredImage(existing.image);
    }

    return company;
  }

  async recordOutboundMessage(count = 1): Promise<void> {
    const period = this.currentPeriod();
    const company = await this.getOrCreate();

    if (company.messagesSentPeriod === period) {
      await this.prisma.company.update({
        where: { id: company.id },
        data: { messagesSentCount: { increment: count } },
      });
      return;
    }

    await this.prisma.company.update({
      where: { id: company.id },
      data: { messagesSentPeriod: period, messagesSentCount: count },
    });
  }

  async getMonthlyMessageCount(): Promise<{ period: string; count: number }> {
    const company = await this.getOrCreate();
    const period = this.currentPeriod();

    return {
      period,
      count:
        company.messagesSentPeriod === period ? company.messagesSentCount : 0,
    };
  }

  async recordFollowerSnapshot(
    date: Date,
    data: {
      followerCount: number;
      targetedReaches?: number;
      blockCount?: number;
    },
  ): Promise<void> {
    const day = this.startOfDay(date);

    await this.prisma.lineFollowerSnapshot.upsert({
      where: { date: day },
      create: { date: day, ...data },
      update: { ...data },
    });
  }

  async getFollowerChange(
    currentCount: number,
    asOf: Date,
  ): Promise<FollowerChange> {
    const compareDate = this.startOfDay(
      new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000),
    );
    const past = await this.prisma.lineFollowerSnapshot.findUnique({
      where: { date: compareDate },
    });

    if (!past || past.followerCount === 0) {
      return { changePercent: null, sinceDate: null };
    }

    const changePercent =
      ((currentCount - past.followerCount) / past.followerCount) * 100;

    return {
      changePercent: Math.round(changePercent * 10) / 10,
      sinceDate: compareDate.toISOString().slice(0, 10),
    };
  }

  private async getOrCreate(): Promise<Company> {
    const existing = await this.prisma.company.findFirst();
    if (existing) return existing;

    return this.prisma.company.create({
      data: {
        name: 'My Company',
        companyType: 'other',
        image: '',
      },
    });
  }

  private async deleteStoredImage(imagePath: string): Promise<void> {
    await this.fileStorage.remove(imagePath, COMPANY_UPLOAD_FOLDER);
  }

  private currentPeriod(date = new Date()): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private startOfDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }
}
