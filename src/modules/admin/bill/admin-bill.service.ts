import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CreditTopupStatus,
  LedgerType,
  Prisma,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { FileStorageService } from '../../../infra/storage/file-storage.service';
import { CompanyService } from '../company/company.service';
import {
  BILL_SLIP_MIME_TO_EXTENSION,
  BILL_SLIP_UPLOAD_FOLDER,
} from './admin-bill.constants';
import { CreateTopupDto } from './dto/top-up.dto';
import { CalculateCreditDto } from './dto/calculate-credit.dto';
import { GetBillHistoryQueryDto } from './dto/get-history.dto';

const SERIALIZABLE_RETRY_LIMIT = 3;
const BILL_HISTORY_PAGE_SIZE = 8;

type CreditSelectionInput = Readonly<{
  packageId?: string;
  paidAmount?: string;
}>;

@Injectable()
export class AdminBillService {
  private readonly logger = new Logger(AdminBillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly companyService: CompanyService,
    private readonly fileStorage: FileStorageService,
  ) {}

  async getExchangeRate() {
    const rate = await this.findActiveExchangeRate();

    return {
      id: rate.id,
      creditsPerThb: rate.creditsPerThb.toString(),
      effectiveFrom: rate.effectiveFrom,
      effectiveTo: rate.effectiveTo,
    };
  }

  async getPackages() {
    const [rate, packages] = await Promise.all([
      this.findActiveExchangeRate(),
      this.prisma.creditPackagePrice.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { priceThb: 'asc' }],
        select: {
          id: true,
          name: true,
          priceThb: true,
          popular: true,
          sortOrder: true,
        },
      }),
    ]);

    return {
      creditsPerThb: rate.creditsPerThb.toString(),
      packages: packages.map((packagePrice) =>
        this.toCreditQuote({
          packageId: packagePrice.id,
          packageName: packagePrice.name,
          paidAmount: packagePrice.priceThb,
          creditsPerThb: rate.creditsPerThb,
          popular: packagePrice.popular,
          sortOrder: packagePrice.sortOrder,
        }),
      ),
    };
  }

  async calculateCredit(dto: CalculateCreditDto) {
    const rate = await this.findActiveExchangeRate();
    const selection = await this.resolveSelection(dto);

    return this.toCreditQuote({
      ...selection,
      creditsPerThb: rate.creditsPerThb,
    });
  }

  async createTopup(requestedById: string, dto: CreateTopupDto) {
    const rate = await this.findActiveExchangeRate();
    const selection = await this.resolveSelection(dto);
    const creditAmount = this.toCreditAmount(
      selection.paidAmount,
      rate.creditsPerThb,
    );
    const companyId = await this.companyService.getCompanyId();
    const extension = BILL_SLIP_MIME_TO_EXTENSION[dto.slip.mimetype];
    if (!extension) {
      throw new BadRequestException('Unsupported upload type');
    }

    // A payment slip is private: it is only ever handed out as a signed URL.
    const slipImage = await this.fileStorage.upload({
      visibility: 'private',
      folder: BILL_SLIP_UPLOAD_FOLDER,
      body: dto.slip.buffer,
      contentType: dto.slip.mimetype,
      extension,
    });

    try {
      const topup = await this.prisma.creditTopupHistory.create({
        data: {
          companyId,
          requestedById,
          type: dto.type,
          exchangeRateId: rate.id,
          packagePriceId: selection.packageId,
          paidAmount: selection.paidAmount,
          creditAmount,
          slipImage,
        },
        include: {
          requestedBy: {
            select: { id: true, username: true },
          },
        },
      });

      return await this.withSlipUrl(topup);
    } catch (error) {
      await this.fileStorage.remove(slipImage, BILL_SLIP_UPLOAD_FOLDER);
      throw error;
    }
  }

  async confirmTopup(topupId: string, approvedById: string) {
    const result = await this.runSerializable(async (tx) => {
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

    // Signed outside the transaction; the slip is not part of the accounting.
    return { ...result, topup: await this.withSlipUrl(result.topup) };
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

    const topup = await this.prisma.creditTopupHistory.findUniqueOrThrow({
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

    return this.withSlipUrl(topup);
  }

  async getHistory(query: GetBillHistoryQueryDto) {
    const companyId = await this.companyService.getCompanyId();
    const where: Prisma.CreditTopupHistoryWhereInput = {
      companyId,
      ...(query.status === 'paid'
        ? { status: CreditTopupStatus.APPROVED }
        : query.status === 'pending'
          ? { status: CreditTopupStatus.PENDING }
          : query.status === 'failed'
            ? { status: CreditTopupStatus.REJECTED }
            : {}),
    };
    const skip = (query.page - 1) * BILL_HISTORY_PAGE_SIZE;
    const include = {
      requestedBy: {
        select: { id: true, username: true },
      },
      approvedBy: {
        select: { id: true, username: true },
      },
      rejectedBy: {
        select: { id: true, username: true },
      },
    } as const;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.creditTopupHistory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: BILL_HISTORY_PAGE_SIZE,
        include,
      }),
      this.prisma.creditTopupHistory.count({ where }),
    ]);

    return {
      items: await Promise.all(items.map((item) => this.withSlipUrl(item))),
      pagination: {
        page: query.page,
        limit: BILL_HISTORY_PAGE_SIZE,
        total,
        totalPages: Math.ceil(total / BILL_HISTORY_PAGE_SIZE),
        hasPreviousPage: query.page > 1,
        hasNextPage: skip + items.length < total,
      },
    };
  }

  /**
   * Swaps the stored slip reference for a URL the dashboard can open: a
   * short-lived signed URL for an R2 slip, the old public path for a legacy one.
   */
  private async withSlipUrl<T extends { slipImage: string }>(
    topup: T,
  ): Promise<T> {
    const slipImage = await this.fileStorage.url(topup.slipImage);
    return { ...topup, slipImage: slipImage ?? topup.slipImage };
  }

  private async findActiveExchangeRate() {
    const now = new Date();
    const rate = await this.prisma.creditExchangeRate.findFirst({
      where: {
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: {
        id: true,
        creditsPerThb: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
    });

    if (!rate) {
      throw new ServiceUnavailableException(
        'Credit exchange rate is not configured',
      );
    }

    return rate;
  }

  private async resolveSelection(input: CreditSelectionInput): Promise<{
    packageId?: string;
    packageName?: string;
    popular?: boolean;
    sortOrder?: number;
    paidAmount: Prisma.Decimal;
  }> {
    if (input.packageId) {
      const packagePrice = await this.prisma.creditPackagePrice.findFirst({
        where: { id: input.packageId, active: true },
        select: {
          id: true,
          name: true,
          priceThb: true,
          popular: true,
          sortOrder: true,
        },
      });

      if (!packagePrice) {
        throw new NotFoundException('Active credit package not found');
      }

      return {
        packageId: packagePrice.id,
        packageName: packagePrice.name,
        popular: packagePrice.popular,
        sortOrder: packagePrice.sortOrder,
        paidAmount: packagePrice.priceThb,
      };
    }

    if (input.paidAmount) {
      return { paidAmount: new Prisma.Decimal(input.paidAmount) };
    }

    throw new BadRequestException('Send exactly one packageId or paidAmount');
  }

  private toCreditQuote(input: {
    packageId?: string;
    packageName?: string;
    paidAmount: Prisma.Decimal;
    creditsPerThb: Prisma.Decimal;
    popular?: boolean;
    sortOrder?: number;
  }) {
    const creditAmount = this.toCreditAmount(
      input.paidAmount,
      input.creditsPerThb,
    );

    return {
      source: input.packageId ? ('package' as const) : ('custom' as const),
      packageId: input.packageId ?? null,
      packageName: input.packageName ?? null,
      paidAmount: input.paidAmount.toString(),
      creditsPerThb: input.creditsPerThb.toString(),
      creditAmount: creditAmount.toString(),
      pricePerCredit: input.paidAmount
        .div(creditAmount)
        .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
        .toString(),
      popular: input.popular ?? false,
      sortOrder: input.sortOrder ?? null,
    };
  }

  private toCreditAmount(
    paidAmount: Prisma.Decimal,
    creditsPerThb: Prisma.Decimal,
  ): Prisma.Decimal {
    return paidAmount
      .mul(creditsPerThb)
      .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
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
}
