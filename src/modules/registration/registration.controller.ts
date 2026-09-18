import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegistrationService } from './registration.service';
import { RegisterDto } from './dto/register.dto';
import { isRegistrationEnabled } from './registration-feature';

@Controller('registration')
export class RegistrationController {
  constructor(
    private readonly registerService: RegistrationService,
    private readonly configService: ConfigService,
  ) {}

  @Post('register')
  async register(@Body() body: RegisterDto) {
    if (!isRegistrationEnabled(this.configService)) {
      throw new ForbiddenException('Registration is currently disabled');
    }

    const payload = await this.registerService.register(body);

    return {
      message: 'สมัครสมาชิกสำเร็จ',
      data: payload,
    };
  }
}
