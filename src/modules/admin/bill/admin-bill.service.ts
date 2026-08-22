import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  CreditTopupStatus,
  LedgerType,
  PaymentType,
  Prisma,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CompanyService } from '../company/company.service';
import {
  BILL_SLIP_ALLOWED_EXTENSIONS,
  BILL_SLIP_MAX_BYTES,
  BILL_SLIP_MIME_TO_EXTENSION,
  BILL_SLIP_UPLOAD_URL_PREFIX,
} from './admin-bill.constants';

const BILL_SLIP_UPLOAD_DIR = join(process.cwd(), 'uploads', 'billing');
const SERIALIZABLE_RETRY_LIMIT = 3;

@Injectable()
export class AdminBillService {
  private readonly logger = new Logger(AdminBillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly companyService: CompanyService,
  ) {}

  async createTopup(requestedById: string, request: FastifyRequest) {
    if (!request.isMultipart()) {
      throw new BadRequestException('Credit amount and slip are required');
    }

    let rawCredit = '';
    let rawType = 'Slip';
    let slipBuffer: Buffer | undefined;
    let slipExtension = '';

    try {
      for await (const part of request.parts({
        limits: { files: 1, fileSize: BILL_SLIP_MAX_BYTES },
      })) {
        if (part.type === 'file') {
          if (
            (part.fieldname !== 'slip' && part.fieldname !== 'image') ||
            slipBuffer
          ) {
            throw new BadRequestException(
              'Only one payment image is allowed in the slip or image field',
            );
          }

          const clientExtension = extname(part.filename).toLowerCase();
          if (
            !BILL_SLIP_ALLOWED_EXTENSIONS.includes(
              clientExtension as (typeof BILL_SLIP_ALLOWED_EXTENSIONS)[number],
            )
          ) {
            throw new BadRequestException(
              `Unsupported slip extension. Allowed: ${BILL_SLIP_ALLOWED_EXTENSIONS.join(', ')}`,
            );
          }

          slipExtension = BILL_SLIP_MIME_TO_EXTENSION[part.mimetype];
          if (!slipExtension) {
            throw new BadRequestException(
              `Unsupported slip type. Allowed: ${Object.keys(
                BILL_SLIP_MIME_TO_EXTENSION,
              ).join(', ')}`,
            );
          }

          slipBuffer = await part.toBuffer();
          if (part.file.truncated) {
            throw new BadRequestException(
              `Slip exceeds the ${BILL_SLIP_MAX_BYTES / (1024 * 1024)}MB limit`,
            );
          }

          continue;
        }

        if (part.fieldname === 'credit' || part.fieldname === 'creditAmount') {
          rawCredit = String(part.value).trim();
        } else if (part.fieldname === 'type') {
          rawType = String(part.value).trim();
        }
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Invalid multipart top-up data');
    }

    const paymentType = this.parsePaymentType(rawType);

    let creditAmount: Prisma.Decimal;
    try {
      creditAmount = new Prisma.Decimal(rawCredit);
    } catch {
      throw new BadRequestException('Credit amount must be a valid number');
    }

    if (
      !creditAmount.isFinite() ||
      creditAmount.lessThanOrEqualTo(0) ||
      creditAmount.decimalPlaces() > 6 ||
      !slipBuffer ||
      !slipExtension
    ) {
      throw new BadRequestException(
        'A positive credit amount and one slip image are required',
      );
    }

    const companyId = await this.companyService.getCompanyId();
    await mkdir(BILL_SLIP_UPLOAD_DIR, { recursive: true });

    const filename = `${randomUUID()}${slipExtension}`;
    const slipFilePath = join(BILL_SLIP_UPLOAD_DIR, filename);
    const slipImage = `${BILL_SLIP_UPLOAD_URL_PREFIX}/${filename}`;
    await writeFile(slipFilePath, slipBuffer);

    try {
      return await this.prisma.creditTopupHistory.create({
        data: {
          companyId,
          requestedById,
          type: paymentType,
          creditAmount,
          slipImage,
        },
        include: {
          requestedBy: {
            select: { id: true, username: true },
          },
        },
      });
    } catch (error) {
      await this.deleteStoredSlip(slipImage);
      throw error;
    }
  }

  async confirmTopup(topupId: string, approvedById: string) {
    return this.runSerializable(async (tx) => {
      const claimed = await tx.creditTopupHistory.updateMany({
        where: {
          id: topupId,
          status: CreditTopupStatus.PENDING,
        },
        data: {
          status: CreditTopupStatus.APPROVED,
          approvedById,
          approvedAt: new Date(),
        },
      });

      if (claimed.count === 0) {
        const existing = await tx.creditTopupHistory.findUnique({
          where: { id: topupId },
        });

        if (!existing) {
          throw new NotFoundException('Top-up request not found');
        }

        if (existing.status === CreditTopupStatus.APPROVED) {
          throw new ConflictException('Top-up request is already approved');
        }

        throw new ConflictException('Top-up request cannot be approved');
      }

      const topup = await tx.creditTopupHistory.findUniqueOrThrow({
        where: { id: topupId },
      });

      const wallet = await tx.creditWallet.upsert({
        where: { companyId: topup.companyId },
        create: {
          companyId: topup.companyId,
          balanceCredit: topup.creditAmount,
          lifetimeTopupCredit: topup.creditAmount,
        },
        update: {
          balanceCredit: { increment: topup.creditAmount },
          lifetimeTopupCredit: { increment: topup.creditAmount },
        },
        select: {
          id: true,
          companyId: true,
          balanceCredit: true,
          reservedCredit: true,
          lifetimeTopupCredit: true,
          lifetimeSpentCredit: true,
        },
      });

      await tx.creditLedger.create({
        data: {
          walletId: wallet.id,
          type: LedgerType.TOPUP,
          amountCredit: topup.creditAmount,
          balanceAfterCredit: wallet.balanceCredit,
          idempotencyKey: `topup:${topup.id}`,
          note: `Slip top-up ${topup.id}`,
        },
      });

      return {
        topup,
        wallet,
      };
    });
  }

  async rejectTopup(topupId: string, rejectedById: string) {
    const rejected = await this.prisma.creditTopupHistory.updateMany({
      where: {
        id: topupId,
        status: CreditTopupStatus.PENDING,
      },
      data: {
        status: CreditTopupStatus.REJECTED,
        rejectedById,
        rejectedAt: new Date(),
      },
    });

    if (rejected.count === 0) {
      const existing = await this.prisma.creditTopupHistory.findUnique({
        where: { id: topupId },
        select: { status: true },
      });

      if (!existing) {
        throw new NotFoundException('Top-up request not found');
      }

      throw new ConflictException(
        `Top-up request is already ${existing.status.toLowerCase()}`,
      );
    }

    return this.prisma.creditTopupHistory.findUniqueOrThrow({
      where: { id: topupId },
      include: {
        requestedBy: {
          select: { id: true, username: true },
        },
        rejectedBy: {
          select: { id: true, username: true },
        },
      },
    });
  }

  async getHistory() {
    const companyId = await this.companyService.getCompanyId();

    return this.prisma.creditTopupHistory.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        requestedBy: {
          select: { id: true, username: true },
        },
        approvedBy: {
          select: { id: true, username: true },
        },
        rejectedBy: {
          select: { id: true, username: true },
        },
      },
    });
  }

  private parsePaymentType(value: string): PaymentType {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[-_\s]/g, '');

    if (normalized === '1' || normalized === 'slip') {
      return PaymentType.Slip;
    }

    if (normalized === '2' || normalized === 'qrcode') {
      return PaymentType.QRcode;
    }

    throw new BadRequestException('Top-up type must be Slip, QRcode, 1, or 2');
  }

  private async runSerializable<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';
        if (!retryable || attempt === SERIALIZABLE_RETRY_LIMIT) throw error;

        this.logger.warn(
          `Retrying serialized credit top-up (${attempt}/${SERIALIZABLE_RETRY_LIMIT})`,
        );
      }
    }

    throw new Error('Serializable credit top-up retry exhausted');
  }

  private async deleteStoredSlip(slipImage: string): Promise<void> {
    if (!slipImage.startsWith(`${BILL_SLIP_UPLOAD_URL_PREFIX}/`)) return;

    const filename = slipImage.slice(BILL_SLIP_UPLOAD_URL_PREFIX.length + 1);
    try {
      await unlink(join(BILL_SLIP_UPLOAD_DIR, filename));
    } catch {
      // Best-effort cleanup; a missing file is not an error.
    }
  }
}
