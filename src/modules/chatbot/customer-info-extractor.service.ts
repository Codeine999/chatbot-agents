import { Injectable } from '@nestjs/common';

export interface ExtractedCustomerInfo {
  name?: string;
  phone?: string;
  bankNumber?: string;
  bankName?: string;
}

@Injectable()
export class CustomerInfoExtractorService {
  extract(text: string): ExtractedCustomerInfo {
    return {
      name: this.extractLineValue(text, ['ชื่อ', 'name']),
      phone: this.normalizePhone(
        this.extractLineValue(text, [
          'เบอร์โทร',
          'เบอร์',
          'โทร',
          'phone',
          'tel',
        ]),
      ),
      bankNumber: this.normalizeBankNumber(
        this.extractLineValue(text, [
          'เลขบัญชี',
          'บัญชี',
          'bank\\s*number',
          'account',
        ]),
      ),
      bankName: this.extractLineValue(text, [
        'ธนาคาร',
        'bank\\s*name',
        'bank(?!\\s*number)',
      ]),
    };
  }

  getMissingFields(extracted: ExtractedCustomerInfo): string[] {
    const missingFields: string[] = [];

    if (!extracted.name) {
      missingFields.push('ชื่อ');
    }

    if (!extracted.phone) {
      missingFields.push('เบอร์โทร');
    }

    if (!extracted.bankNumber) {
      missingFields.push('เลขบัญชี');
    }

    if (!extracted.bankName) {
      missingFields.push('ธนาคาร');
    }

    return missingFields;
  }

  isComplete(extracted: ExtractedCustomerInfo): boolean {
    return this.getMissingFields(extracted).length === 0;
  }

  private extractLineValue(
    text: string,
    labelPatterns: string[],
  ): string | undefined {
    const labels = labelPatterns.join('|');
    const regex = new RegExp(
      `(?:^|\\n)\\s*(?:${labels})\\s*(?::|：)?\\s*(.+?)\\s*(?=\\n|$)`,
      'iu',
    );
    const match = text.match(regex);
    const value = match?.[1]?.trim();

    return value || undefined;
  }

  private normalizePhone(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    return value.replace(/[^\d+]/g, '') || undefined;
  }

  private normalizeBankNumber(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    return value.replace(/[\s-]/g, '') || undefined;
  }
}
