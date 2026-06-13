import { Body, Controller, Post } from '@nestjs/common';
import { GetAllUsersDto } from './dto/get-all-users.dto';
import { UsersService } from './users.service';

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
}
