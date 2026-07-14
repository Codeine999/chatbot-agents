import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from '../../../generated/prisma/client';
import { AdminJwtService } from './admin-jwt.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { CreateAdminDto } from './dto/create-admin.dto';

const ADMIN_PUBLIC_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  picture: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminJwtService: AdminJwtService,
  ) {}

  async login(input: AdminLoginDto) {
    const admin = await this.prisma.admin.findUnique({
      where: { username: input.username },
    });

    if (!admin || !(await bcrypt.compare(input.password, admin.password))) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const accessToken = this.adminJwtService.sign({
      id: admin.id,
      username: admin.username,
      role: admin.role,
    });

    const { password: _password, ...safeAdmin } = admin;

    return {
      accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: this.adminJwtService.tokenExpiresInSeconds,
      admin: safeAdmin,
    };
  }

  async create(input: CreateAdminDto) {
    const password = await bcrypt.hash(input.password, 12);

    try {
      return await this.prisma.admin.create({
        data: {
          ...input,
          email: input.email.toLowerCase(),
          picture: input.picture ?? null,
          password,
        },
        select: ADMIN_PUBLIC_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException('Admin username, email, or phone exists');
        }
      }

      throw error;
    }
  }
}
