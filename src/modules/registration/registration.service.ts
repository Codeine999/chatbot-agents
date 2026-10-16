import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CompleteRegisterSessionData } from './types/register-session.types';
import { CustomerIdentityService } from '../users/customers/customer-identity.service';
import { CommerceFeatureService } from '../commerce/commerce-feature.service';
import { CommerceScopeService } from '../commerce/commerce-scope.service';
import type { CommerceScope } from '../commerce/types/commerce-scope';

export interface RegisterMemberResult {
  username: string;
  password: string;
}

@Injectable()
export class RegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identities: CustomerIdentityService,
    private readonly commerceFeatures: CommerceFeatureService,
    private readonly commerceScopes: CommerceScopeService,
  ) {}

  async register(
    data: CompleteRegisterSessionData,
  ): Promise<RegisterMemberResult> {
    return this.createMember(data);
  }

  /** Called only by the verified LINE chat flow; public registration keeps its old contract. */
  async registerForLine(
    data: CompleteRegisterSessionData,
    lineUserId: string,
  ): Promise<RegisterMemberResult> {
    if (!this.commerceFeatures.catalogEnabled) return this.register(data);
    try {
      const scope = await this.commerceScopes.forLineDeployment();
      return await this.createMember(data, { scope, lineUserId });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException(
        'สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
      );
    }
  }

  private async createMember(
    data: CompleteRegisterSessionData,
    link?: { scope: CommerceScope; lineUserId: string },
  ): Promise<RegisterMemberResult> {
    await this.assertUniqueMemberData(data);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const username = await this.generateUniqueUsername(data.phoneNumber);
      const password = this.generatePassword();
      const hashedPassword = await bcrypt.hash(password, 10);

      try {
        const memberData = {
          username,
          password: hashedPassword,
          firstname: data.firstName,
          lastname: data.lastName,
          phone: data.phoneNumber,
          bankname: data.bankName,
          banknumber: data.bankAccount,
          statusaccount: 'pending',
        };
        if (link) {
          await this.prisma.$transaction(async (tx) => {
            const member = await tx.member.create({ data: memberData });
            await this.identities.linkRegisteredLine(
              tx,
              link.scope,
              {
                channel: 'LINE',
                connectionKey: this.commerceFeatures.lineConnectionKey,
                externalUserId: link.lineUserId,
              },
              member.uuid,
            );
          });
        } else {
          await this.prisma.member.create({ data: memberData });
        }

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

    if (!existingMember) return;

    if (existingMember.phone === data.phoneNumber) {
      throw new ConflictException('เบอร์โทรนี้สมัครสมาชิกไปเรียบร้อยแล้ว');
    }

    if (existingMember.banknumber === data.bankAccount) {
      throw new ConflictException('เลขบัญชีนี้สมัครสมาชิกไปเรียบร้อยแล้ว');
    }

    throw new ConflictException('คุณสมัครสมาชิกไปเรียบร้อยแล้ว');
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
