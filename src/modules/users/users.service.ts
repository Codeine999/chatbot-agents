import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GetAllUsersDto } from './dto/get-all-users.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  getAll(filters: GetAllUsersDto) {
    const where: Prisma.MemberWhereInput = {
      username: filters.username
        ? { contains: filters.username, mode: 'insensitive' }
        : undefined,
      firstname: filters.firstname
        ? { contains: filters.firstname, mode: 'insensitive' }
        : undefined,
      lastname: filters.lastname
        ? { contains: filters.lastname, mode: 'insensitive' }
        : undefined,
      phone: filters.phone,
      statusaccount: filters.statusaccount,
    };

    return this.prisma.member.findMany({
      where,
      select: {
        uuid: true,
        username: true,
        firstname: true,
        lastname: true,
        phone: true,
        bankname: true,
        banknumber: true,
        statusaccount: true,
      },
    });
  }
}
