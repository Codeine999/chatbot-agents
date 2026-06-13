import { Injectable } from '@nestjs/common';
import {
  REGISTER_BANK_ALIASES,
  REGISTER_FIELD_ALIASES,
} from './register-fields.constant';
import { RegisterSessionData } from '../types/register-session.types';

@Injectable()
export class RegisterParser {
  parse(
    text: string,
    existingData: RegisterSessionData = {},
  ): RegisterSessionData {
    const data: RegisterSessionData = {};
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const usedLineIndexes = new Set<number>();

    lines.forEach((line, index) => {
      const match =
        line.match(/^([^:：]+)[:：](.*)$/) ?? line.match(/^(\S+)\s+(.+)$/);

      if (!match) {
        return;
      }

      const key = this.normalizeRegisterKey(match[1]);
      const field = REGISTER_FIELD_ALIASES[key];
      const value = match[2].trim();

      if (!field || value.length === 0) {
        return;
      }

      data[field] = this.normalizeRegisterValue(field, value);
      usedLineIndexes.add(index);
    });

    this.inferUnlabeledFields(lines, data, existingData, usedLineIndexes);

    return data;
  }

  private inferUnlabeledFields(
    lines: string[],
    data: RegisterSessionData,
    existingData: RegisterSessionData,
    usedLineIndexes: Set<number>,
  ) {
    lines.forEach((line, index) => {
      if (usedLineIndexes.has(index)) {
        return;
      }

      const digits = this.normalizeDigits(line);

      if (
        this.isFieldMissing('phoneNumber', data, existingData) &&
        this.isPhoneNumber(digits)
      ) {
        data.phoneNumber = digits;
        usedLineIndexes.add(index);
      }
    });

    lines.forEach((line, index) => {
      if (usedLineIndexes.has(index)) {
        return;
      }

      const digits = this.normalizeDigits(line);

      if (
        this.isFieldMissing('bankAccount', data, existingData) &&
        this.isBankAccount(digits)
      ) {
        data.bankAccount = digits;
        usedLineIndexes.add(index);
      }
    });

    lines.forEach((line, index) => {
      if (usedLineIndexes.has(index)) {
        return;
      }

      if (!this.isFieldMissing('bankName', data, existingData)) {
        return;
      }

      const bankName = this.matchBankName(line);

      if (bankName) {
        data.bankName = bankName;
        usedLineIndexes.add(index);
      }
    });

    const nameFields: Array<keyof RegisterSessionData> = [
      'firstName',
      'lastName',
    ];

    lines.forEach((line, index) => {
      if (usedLineIndexes.has(index) || !this.isTextOnly(line)) {
        return;
      }

      const field = nameFields.find((key) =>
        this.isFieldMissing(key, data, existingData),
      );

      if (!field) {
        return;
      }

      data[field] = line.trim();
      usedLineIndexes.add(index);
    });
  }

  private normalizeRegisterKey(key: string): string {
    return key
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, '');
  }

  private normalizeRegisterValue(
    field: keyof RegisterSessionData,
    value: string,
  ): string {
    if (field === 'phoneNumber' || field === 'bankAccount') {
      return this.normalizeDigits(value);
    }

    if (field === 'bankName') {
      return this.matchBankName(value) ?? '';
    }

    return value.trim();
  }

  private normalizeDigits(value: string): string {
    return value.replace(/\D/g, '');
  }

  private isPhoneNumber(value: string): boolean {
    return /^0\d{9}$/.test(value);
  }

  private isBankAccount(value: string): boolean {
    return /^\d{10,12}$/.test(value);
  }

  private matchBankName(value: string): string | undefined {
    const key = this.normalizeBankKey(value);

    return REGISTER_BANK_ALIASES[key];
  }

  private normalizeBankKey(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/ชื่อธนาคาร/g, '')
      .replace(/ธนาคาร/g, '')
      .replace(/[\s_.:-]/g, '');
  }

  private isFieldMissing(
    field: keyof RegisterSessionData,
    data: RegisterSessionData,
    existingData: RegisterSessionData,
  ): boolean {
    return !(data[field]?.trim() || existingData[field]?.trim());
  }

  private isTextOnly(value: string): boolean {
    return /^[\p{L}\p{M}.' -]+$/u.test(value.trim());
  }
}
