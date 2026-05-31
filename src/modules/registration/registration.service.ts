import { Injectable, BadRequestException, Inject, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Customer } from './schema/customer.schema';
import { Model, Types } from 'mongoose';

@Injectable()
export class RegistrationService {
    constructor(
        @InjectModel(Customer.name) private customerModel: Model<Customer>,
    ) { }

    async register(
        body: any
    ): Promise<any> {
        const {
          username,
          password,
          confirmPassword,
          email,
          phone,
          name,
          lastName,
          birthDay,
          bankBrand,
          bankName,
          bankNumber,
        } = body;

        if (password !== confirmPassword) {
            throw new BadRequestException('รหัสผ่านทั้ง 2 ไม่เหมือนกัน');
        }

        // const exist = await this.userService.findByPhone(phone);
        // if (exist) throw new BadRequestException('มีผู้ใช้เบอร์นี้อยู่ในระบบอยู่แล้ว');
        
        
    }

}
