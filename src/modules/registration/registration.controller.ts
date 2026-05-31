import { Body, Controller, Post } from '@nestjs/common';
import { RegistrationService } from './registration.service';

@Controller('registration')
export class RegistrationController {
  constructor(private readonly registerService: RegistrationService) {}

  @Post('register')
  async register(@Body() body: any) {
    const payload = await this.registerService.register(body);

    return {
      message: 'สมัครสมาชิกสำเร็จ',
      data: payload,
    };
  }
  
}
