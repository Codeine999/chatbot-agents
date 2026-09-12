import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegistrationService } from './registration.service';
import { RegisterDto } from './dto/register.dto';

@Controller('registration')
export class RegistrationController {
  constructor(
    private readonly registerService: RegistrationService,
    private readonly configService: ConfigService,
  ) {}

  @Post('register')
  async register(@Body() body: RegisterDto) {
    if (this.configService.get<string>('CAN_REGISTER') === 'false') {
      throw new ForbiddenException('Registration is currently disabled');
    }

    const payload = await this.registerService.register(body);

    return {
      message: 'สมัครสมาชิกสำเร็จ',
      data: payload,
    };
  }
}
