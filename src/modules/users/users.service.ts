import { Injectable } from '@nestjs/common';
import { LineChatSender, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GetAllUsersDto } from './dto/get-all-users.dto';
import type {
  ListLineUsersQueryDto,
  ListRegisteredUsersQueryDto,
  UserListSort,
} from './dto/list-users.query.dto';

export type Paginated<TItem> = {
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type RegisteredUserListItem = {
  id: string;
  name: string;
  username: string;
  phone: string;
  status: string;
  joinedAt: string;
  /** โปรไฟล์ LINE ที่ผูกไว้ ถ้ายังไม่เคยผูกจะเป็น null ทั้งชุด */
  lineId: string | null;
  lineName: string | null;
  avatar: string | null;
  lastActiveAt: string | null;
};

export type LineUserListItem = {
  id: string;
  displayName: string;
  lineId: string;
  avatar: string | null;
  firstSeenAt: string;
  lastActiveAt: string | null;
  /** นับเฉพาะข้อความที่ผู้ใช้ส่งเข้ามา ไม่รวมที่บอท/แอดมินตอบกลับ */
  messageCount: number;
};

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

  async getCounts(): Promise<{ registered: number; line: number }> {
    const [registered, line] = await Promise.all([
      this.prisma.member.count(),
      this.prisma.lineMember.count({ where: { memberId: null } }),
    ]);

    return { registered, line };
  }

  async listRegistered(
    query: ListRegisteredUsersQueryDto,
  ): Promise<Paginated<RegisteredUserListItem>> {
    const search = query.search?.trim();

    const where: Prisma.MemberWhereInput = {
      ...(query.status && query.status !== 'all'
        ? { statusaccount: query.status }
        : {}),
      ...(search
        ? {
            OR: [
              { firstname: { contains: search, mode: 'insensitive' } },
              { lastname: { contains: search, mode: 'insensitive' } },
              { username: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              {
                lineMembers: {
                  some: {
                    displayName: { contains: search, mode: 'insensitive' },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const total = await this.prisma.member.count({ where });
    const { page, skip, pageSize } = this.resolvePage(query, total);

    const members = await this.prisma.member.findMany({
      where,
      orderBy: this.registeredOrderBy(query.sort),
      skip,
      take: pageSize,
      select: {
        uuid: true,
        username: true,
        firstname: true,
        lastname: true,
        phone: true,
        statusaccount: true,
        createdAt: true,
        lineMembers: {
          // โปรไฟล์ LINE ที่ใช้งานล่าสุดเป็นตัวแทนเวลามีหลายบัญชีผูกไว้
          orderBy: { lastActiveAt: { sort: 'desc', nulls: 'last' } },
          take: 1,
          select: {
            lineUserId: true,
            displayName: true,
            pictureUrl: true,
            lastActiveAt: true,
          },
        },
      },
    });

    const items = members.map((member): RegisteredUserListItem => {
      const lineMember = member.lineMembers[0];

      return {
        id: member.uuid,
        name: `${member.firstname} ${member.lastname}`.trim(),
        username: member.username,
        phone: member.phone,
        status: member.statusaccount,
        joinedAt: member.createdAt.toISOString(),
        lineId: lineMember?.lineUserId ?? null,
        lineName: lineMember?.displayName ?? null,
        avatar: lineMember?.pictureUrl ?? null,
        lastActiveAt: lineMember?.lastActiveAt?.toISOString() ?? null,
      };
    });

    return { items, total, page, pageSize };
  }

  async listLineUsers(
    query: ListLineUsersQueryDto,
  ): Promise<Paginated<LineUserListItem>> {
    const search = query.search?.trim();

    const where: Prisma.LineMemberWhereInput = {
      ...(query.registered === 'false'
        ? { memberId: null }
        : query.registered === 'true'
          ? { memberId: { not: null } }
          : {}),
      ...(search
        ? {
            OR: [
              { displayName: { contains: search, mode: 'insensitive' } },
              { lineUserId: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const total = await this.prisma.lineMember.count({ where });
    const { page, skip, pageSize } = this.resolvePage(query, total);

    const lineMembers = await this.prisma.lineMember.findMany({
      where,
      orderBy: this.lineOrderBy(query.sort),
      skip,
      take: pageSize,
      select: {
        id: true,
        lineUserId: true,
        displayName: true,
        pictureUrl: true,
        createdAt: true,
        lastActiveAt: true,
        _count: {
          select: { chatHistories: { where: { sender: LineChatSender.USER } } },
        },
      },
    });

    const items = lineMembers.map((lineMember): LineUserListItem => {
      return {
        id: lineMember.id,
        displayName: lineMember.displayName,
        lineId: lineMember.lineUserId,
        avatar: lineMember.pictureUrl ?? null,
        firstSeenAt: lineMember.createdAt.toISOString(),
        lastActiveAt: lineMember.lastActiveAt?.toISOString() ?? null,
        messageCount: lineMember._count.chatHistories,
      };
    });

    return { items, total, page, pageSize };
  }

  /** ถ้าตัวกรองทำให้หน้าปัจจุบันเกินขอบ ให้ดึงกลับมาหน้าสุดท้ายที่ยังมีข้อมูล */
  private resolvePage(
    query: { page: number; pageSize: number },
    total: number,
  ): { page: number; skip: number; pageSize: number } {
    const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, lastPage);

    return {
      page,
      skip: (page - 1) * query.pageSize,
      pageSize: query.pageSize,
    };
  }

  private registeredOrderBy(
    sort: UserListSort,
  ): Prisma.MemberOrderByWithRelationInput[] {
    switch (sort) {
      case 'name':
        return [{ firstname: 'asc' }, { lastname: 'asc' }];
      case 'oldest':
        return [{ createdAt: 'asc' }];
      // Member ไม่มีเวลาใช้งานล่าสุดของตัวเอง (อยู่ที่ LineMember ซึ่งเป็น
      // ความสัมพันธ์แบบหลายรายการ เรียงจาก Prisma ตรง ๆ ไม่ได้) หน้าเว็บจึงไม่
      // เปิดตัวเลือกนี้ให้แท็บนี้ และถ้ามีคนยิงมาก็ถอยไปใช้วันที่สมัครแทน
      case 'lastActive':
      case 'newest':
      default:
        return [{ createdAt: 'desc' }];
    }
  }

  private lineOrderBy(
    sort: UserListSort,
  ): Prisma.LineMemberOrderByWithRelationInput[] {
    switch (sort) {
      case 'name':
        return [{ displayName: 'asc' }];
      case 'oldest':
        return [{ createdAt: 'asc' }];
      case 'lastActive':
        return [{ lastActiveAt: { sort: 'desc', nulls: 'last' } }];
      case 'newest':
      default:
        return [{ createdAt: 'desc' }];
    }
  }
}
