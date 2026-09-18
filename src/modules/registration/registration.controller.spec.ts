import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegisterDto } from './dto/register.dto';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';

const input: RegisterDto = {
  firstName: 'Test',
  lastName: 'User',
  phoneNumber: '0812345678',
  bankName: 'Test Bank',
  bankAccount: '1234567890',
};

describe('RegistrationController feature gate', () => {
  it.each([undefined, 'false', 'FALSE', ' false ', false])(
    'rejects registration when CAN_REGISTER=%p',
    async (flag) => {
      const register = jest.fn();
      const controller = new RegistrationController(
        { register } as unknown as RegistrationService,
        new ConfigService(flag === undefined ? {} : { CAN_REGISTER: flag }),
      );

      await expect(controller.register(input)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(register).not.toHaveBeenCalled();
    },
  );

  it.each(['true', 'TRUE', ' true ', true])(
    'allows registration only when CAN_REGISTER=%p',
    async (flag) => {
      const register = jest.fn().mockResolvedValue({ username: 'member' });
      const controller = new RegistrationController(
        { register } as unknown as RegistrationService,
        new ConfigService({ CAN_REGISTER: flag }),
      );

      await expect(controller.register(input)).resolves.toEqual({
        message: 'สมัครสมาชิกสำเร็จ',
        data: { username: 'member' },
      });
      expect(register).toHaveBeenCalledWith(input);
    },
  );
});
