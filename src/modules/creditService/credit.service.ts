import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { CreditWalletType } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CreditService {
  private readonly lineReplyCost = 1;

  constructor(private readonly prisma: PrismaService) {}

  async getLineOaCredit() {
    return this.prisma.creditWallet.findUniqueOrThrow({
      where: {
        type: CreditWalletType.LINE_MESSAGE,
      },
      select: {
        id: true,
        type: true,
        balance: true,
        usedTotal: true,
      },
    });
  }

  async reserveLineReplyCredit(): Promise<void> {
    const result = await this.prisma.creditWallet.updateMany({
      where: {
        type: CreditWalletType.LINE_MESSAGE,
        active: true,
        balance: {
          gte: this.lineReplyCost,
        },
      },
      data: {
        balance: {
          decrement: this.lineReplyCost,
        },
        usedTotal: {
          increment: this.lineReplyCost,
        },
      },
    });

    if (result.count === 0) {
      throw new HttpException(
        'Insufficient LINE message credit',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  async refundLineReplyCredit(): Promise<void> {
    await this.prisma.creditWallet.updateMany({
      where: {
        type: CreditWalletType.LINE_MESSAGE,
        active: true,
      },
      data: {
        balance: {
          increment: this.lineReplyCost,
        },
        usedTotal: {
          decrement: this.lineReplyCost,
        },
      },
    });
  }
}
