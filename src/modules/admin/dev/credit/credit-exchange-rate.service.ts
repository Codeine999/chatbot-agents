import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { CreditExchangeRateDto } from './dto/credit-exchange-rate.dto';
import { CreatePackagePriceDto } from './dto/create-package-price.dto';

const SERIALIZABLE_RETRY_LIMIT = 3;

const CREDIT_EXCHANGE_RATE_SELECT = {
  id: true,
  creditsPerThb: true,
  effectiveFrom: true,
  effectiveTo: true,
} as const;

@Injectable()
export class CreditExchangeRateService {
  private readonly logger = new Logger(CreditExchangeRateService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(body: CreditExchangeRateDto) {
    return this.runSerializable(async (tx) => {
      const existing = await tx.creditExchangeRate.findFirst({
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException('Credit exchange rate already exists');
      }

      try {
        return await tx.creditExchangeRate.create({
          data: {
            creditsPerThb: new Prisma.Decimal(body.creditsPerThb),
          },
          select: CREDIT_EXCHANGE_RATE_SELECT,
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException('Credit exchange rate already exists');
        }

        throw error;
      }
    });
  }

  async update(body: CreditExchangeRateDto) {
    return this.runSerializable(async (tx) => {
      const existing = await tx.creditExchangeRate.findFirst({
        select: { id: true },
      });

      if (!existing) {
        throw new NotFoundException('Credit exchange rate not found');
      }

      return tx.creditExchangeRate.update({
        where: { id: existing.id },
        data: {
          creditsPerThb: new Prisma.Decimal(body.creditsPerThb),
          effectiveFrom: new Date(),
          effectiveTo: null,
        },
        select: CREDIT_EXCHANGE_RATE_SELECT,
      });
    });
  }

  createPackage(body: CreatePackagePriceDto) {
    return this.prisma.creditPackagePrice.create({
      data: {
        name: body.name,
        priceThb: new Prisma.Decimal(body.priceThb),
        popular: body.popular ?? false,
        active: body.active ?? true,
        sortOrder: body.sortOrder ?? 0,
      },
    });
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
          `Retrying credit exchange rate transaction (${attempt}/${SERIALIZABLE_RETRY_LIMIT})`,
        );
      }
    }

    throw new Error('Credit exchange rate transaction retry exhausted');
  }
}
