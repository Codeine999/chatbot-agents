import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CompleteRegisterSessionData } from './types/register-session.types';

export interface RegisterMemberResult {
  username: string;
  password: string;
}

@Injectable()
export class RegistrationService {
  constructor(private readonly prisma: PrismaService) {}

  async register(
    data: CompleteRegisterSessionData,
  ): Promise<RegisterMemberResult> {
    await this.assertUniqueMemberData(data);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const username = await this.generateUniqueUsername(data.phoneNumber);
      const password = this.generatePassword();
      const hashedPassword = await bcrypt.hash(password, 10);

      try {
        await this.prisma.member.create({
          data: {
            username,
            password: hashedPassword,
            firstname: data.firstName,
            lastname: data.lastName,
            phone: data.phoneNumber,
            bankname: data.bankName,
            banknumber: data.bankAccount,
            statusaccount: 'pending',
          },
        });

        return {
          username,
          password,
        };
      } catch (error) {
        if (this.isUniqueConstraintError(error, 'username')) {
          continue;
        }

        throw this.mapPrismaError(error);
      }
    }

    throw new InternalServerErrorException(
      'ไม่สามารถสร้างชื่อผู้ใช้ได้ กรุณาลองใหม่อีกครั้ง',
    );
  }

  private async assertUniqueMemberData(data: CompleteRegisterSessionData) {
    const existingMember = await this.prisma.member.findFirst({
      where: {
        OR: [{ phone: data.phoneNumber }, { banknumber: data.bankAccount }],
      },
      select: {
        phone: true,
        banknumber: true,
      },
    });

    if (!existingMember) {
      return;
    }

    if (existingMember.phone === data.phoneNumber) {
      throw new ConflictException('มีผู้ใช้เบอร์โทรนี้อยู่ในระบบแล้ว');
    }

    if (existingMember.banknumber === data.bankAccount) {
      throw new ConflictException('มีเลขบัญชีนี้อยู่ในระบบแล้ว');
    }
  }

  private async generateUniqueUsername(phoneNumber: string): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const username = this.generateUsername(phoneNumber);
      const existingMember = await this.prisma.member.findUnique({
        where: {
          username,
        },
        select: {
          uuid: true,
        },
      });

      if (!existingMember) {
        return username;
      }
    }

    throw new InternalServerErrorException(
      'ไม่สามารถสร้างชื่อผู้ใช้ได้ กรุณาลองใหม่อีกครั้ง',
    );
  }

  private generateUsername(phoneNumber: string): string {
    return `mb${phoneNumber.slice(-4)}${randomInt(1000, 10000)}`;
  }

  private generatePassword(): string {
    return randomBytes(4).toString('hex');
  }

  private mapPrismaError(error: unknown): Error {
    if (this.isUniqueConstraintError(error, 'phone')) {
      return new ConflictException('มีผู้ใช้เบอร์โทรนี้อยู่ในระบบแล้ว');
    }

    if (this.isUniqueConstraintError(error, 'banknumber')) {
      return new ConflictException('มีเลขบัญชีนี้อยู่ในระบบแล้ว');
    }

    if (this.isUniqueConstraintError(error, 'username')) {
      return new ConflictException('ชื่อผู้ใช้นี้ถูกใช้งานแล้ว');
    }

    return error instanceof Error
      ? error
      : new InternalServerErrorException('สมัครสมาชิกไม่สำเร็จ');
  }

  private isUniqueConstraintError(error: unknown, field: string): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return false;
    }

    const target = error.meta?.target;

    return (
      error.code === 'P2002' && Array.isArray(target) && target.includes(field)
    );
  }
}
