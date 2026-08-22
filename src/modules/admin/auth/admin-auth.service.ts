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
  firstname: true,
  lastname: true,
  email: true,
  phone: true,
  image: true,
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
    const admin = await this.prisma.adminMember.findUnique({
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
      return await this.prisma.adminMember
        .create({
          data: {
            username: input.username,
            firstname: input.firstName,
            lastname: input.lastName,
            email: input.email.toLowerCase(),
            phone: input.phone,
            image: input.image ?? null,
            password,
            role: input.role,
          },
          select: ADMIN_PUBLIC_SELECT,
        })
        .then(({ firstname, lastname, ...admin }) => ({
          ...admin,
          firstName: firstname,
          lastName: lastname,
        }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException('Admin username, email, or phone exists');
        }
      }

      throw error;
    }
  }

  async createOwner(input: CreateAdminDto) {
    const existingAdmin = await this.prisma.adminMember.findFirst({
      select: { id: true },
    });

    if (existingAdmin) {
      return 'คุณสมัครไปแล้ว';
    }

    const password = await bcrypt.hash(input.password, 12);

    try {
      const admin = await this.prisma.adminMember.create({
        data: {
          username: input.username,
          firstname: input.firstName,
          lastname: input.lastName,
          email: input.email.toLowerCase(),
          phone: input.phone,
          image: input.image ?? null,
          password,
          role: 'owner',
        },
        select: ADMIN_PUBLIC_SELECT,
      });

      const { firstname, lastname, ...safeAdmin } = admin;

      return {
        ...safeAdmin,
        firstName: firstname,
        lastName: lastname,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException('Admin username, email, or phone exists');
        }
      }

      throw error;
    }
  }

  async authOwner(): Promise<boolean> {
    const existingAdmin = await this.prisma.adminMember.findFirst({
      select: { id: true },
    });

    return Boolean(existingAdmin);
  }
}
