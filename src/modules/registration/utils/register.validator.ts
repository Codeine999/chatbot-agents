import { Injectable } from '@nestjs/common';
import { REGISTER_REQUIRED_FIELDS } from '../utils/register-fields.constant';
import {
  CompleteRegisterSessionData,
  RegisterSessionData,
} from '../types/register-session.types';

@Injectable()
export class RegisterValidator {
  getMissingFields(data: RegisterSessionData): string[] {
    return REGISTER_REQUIRED_FIELDS.filter(({ key }) => !data[key]?.trim()).map(
      ({ label }) => label,
    );
  }

  isComplete(data: RegisterSessionData): data is CompleteRegisterSessionData {
    return this.getMissingFields(data).length === 0;
  }

  isValidPhoneNumber(phoneNumber?: string): boolean {
    return /^0\d{9}$/.test(phoneNumber ?? '');
  }

  isValidBankAccount(bankAccount?: string): boolean {
    return /^\d{10,12}$/.test(bankAccount ?? '');
  }

  isYes(input: string): boolean {
    return ['ใช่', 'yes', 'ตกลง', 'ยืนยัน'].includes(
      input.trim().toLowerCase(),
    );
  }

  isConfirm(input: string): boolean {
    return input.trim() === 'ยืนยัน';
  }
}
