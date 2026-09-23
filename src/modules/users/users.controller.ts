import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AdminGuard } from '../../shared/guards/admin-guard.decorator';
import { GetAllUsersDto } from './dto/get-all-users.dto';
import {
  ListLineUsersQueryDto,
  ListRegisteredUsersQueryDto,
} from './dto/list-users.query.dto';
import { UsersService } from './users.service';

@AdminGuard()
@Controller('api/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('getall')
  async getAll(@Body() filters: GetAllUsersDto) {
    const users = await this.usersService.getAll(filters);

    return {
      message: 'แสดงข้อมูลสำเร็จ',
      data: users,
    };
  }

  /** จำนวนของทั้งสองแท็บบนหน้า users ไม่ขึ้นกับตัวกรอง */
  @Get('counts')
  getCounts() {
    return this.usersService.getCounts();
  }

  /** ผู้ใช้ LINE โดยค่าเริ่มต้นคือคนที่ยังไม่ผูกกับสมาชิกที่สมัครแล้ว */
  @Get('line')
  listLineUsers(@Query() query: ListLineUsersQueryDto) {
    return this.usersService.listLineUsers(query);
  }

  @Get()
  listRegistered(@Query() query: ListRegisteredUsersQueryDto) {
    return this.usersService.listRegistered(query);
  }
}
