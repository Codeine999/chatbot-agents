import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateSysCategoryDto } from './dto/sys-category.dto';

@Injectable()
export class AdminSysCategoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const [total, data] = await Promise.all([
      this.prisma.sysCategory.count(),
      this.prisma.sysCategory.findMany({
        orderBy: { name: 'asc' },
      }),
    ]);

    return { total, data };
  }

  async create(input: CreateSysCategoryDto) {
    try {
      return await this.prisma.sysCategory.create({
        data: { name: input.name },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Category name already exists');
      }

      throw error;
    }
  }

  async remove(id: string): Promise<{ deleted: true }> {
    const category = await this.prisma.sysCategory.findUnique({
      where: { id },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    const answerPatternCount = await this.prisma.answerPattern.count({
      where: { category: category.name },
    });

    if (answerPatternCount > 0) {
      throw new ConflictException(
        `Category is used by ${answerPatternCount} answer pattern(s)`,
      );
    }

    await this.prisma.sysCategory.delete({ where: { id } });
    return { deleted: true };
  }
}
