// src/chatbot/reply-template.service.ts

import { Injectable } from '@nestjs/common';

@Injectable()
export class ReplyTemplateService {
  askRegisterIntent(): string {
    return [
      'กรุณากรอกข้อมูลสมัครสมาชิกตามรูปแบบนี้',
      '',
      'ชื่อ:',
      'นามสกุล:',
      'เบอร์โทร:',
      'ชื่อธนาคาร:',
      'เลขบัญชี:',
      '',
      'ตัวอย่าง:',
      'ชื่อ: สมชาย',
      'นามสกุล: ใจดี',
      'เบอร์โทร: 0812345678',
      'ชื่อธนาคาร: กสิกรไทย',
      'เลขบัญชี: 1234567890',
    ].join('\n');
  }

  missingRegisterFields(fields: string[]): string {
    return [
      `กรุณากรอก ${fields.join(', ')} ให้ครบค่ะ`,
      '',
      'สามารถส่งเฉพาะข้อมูลที่ขาดมาเพิ่มเติมได้เลย',
    ].join('\n');
  }

  pendingRegister(data: {
    firstName: string;
    lastName: string;
    phoneNumber: string;
    bankName: string;
    bankAccount: string;
  }): string {
    return [
      'ได้รับข้อมูลสมัครสมาชิกครบแล้วค่ะ',
      '',
      `ชื่อ: ${data.firstName}`,
      `นามสกุล: ${data.lastName}`,
      `เบอร์โทร: ${data.phoneNumber}`,
      `ธนาคาร: ${data.bankName}`,
      `เลขบัญชี: ${data.bankAccount}`,
      '',
      'ระบบกำลังรอดำเนินการสมัครสมาชิกในขั้นตอนถัดไป',
    ].join('\n');
  }

  /**
   * The greeting shown when there is nothing else to say.
   *
   * It takes the captions of the menu that is actually live rather than
   * naming buttons of its own: a tenant who rebuilds its rich menu would
   * otherwise have this message describing buttons that no longer exist, and
   * nothing would fail to reveal it.
   */
  defaultMessage(menuLabels: readonly string[] = []): string {
    if (!menuLabels.length) {
      return [
        'สวัสดีค่ะ',
        'เลือกเมนูด้านล่าง หรือพิมพ์คำถามที่ต้องการสอบถามได้เลยค่ะ',
      ].join('\n');
    }

    return [
      'สวัสดีค่ะ',
      'กรุณาเลือกบริการที่ต้องการใช้งาน',
      '',
      ...menuLabels.map((label) => `• ${label}`),
      '',
      'หรือพิมพ์คำถามที่ต้องการสอบถามได้เลยค่ะ',
    ].join('\n');
  }

  registerUnavailable(): string {
    return 'ขออภัยค่ะ ขณะนี้ยังไม่มีระบบสมัครสมาชิก';
  }

  cancelled(): string {
    return 'ยกเลิกรายการแล้วค่ะ';
  }

  askAiChatQuestion(): string {
    return 'ได้เลยค่ะ ต้องการสอบถามเรื่องอะไรคะ';
  }

  contactAdmin(): string {
    return 'รับทราบค่ะ เดี๋ยวแอดมินจะเข้ามาดูแลให้นะคะ';
  }

  stickerGreeting(): string {
    return 'สวัสดีค่ะ สอบถามเรื่องไหนคะ';
  }

  stickerThanks(): string {
    return 'ด้วยความยินดีค่ะ';
  }

  stickerUnknown(): string {
    return 'รับสติ๊กเกอร์แล้วค่ะ 😊 หากมีอะไรให้ช่วย พิมพ์ข้อความมาได้ตลอดนะคะ';
  }

  messageTooLong(): string {
    return 'ข้อความยาวเกินไปค่ะ กรุณาพิมพ์ให้สั้นลงแล้วส่งใหม่อีกครั้งนะคะ';
  }

  statusUnavailable(): string {
    return 'ขออภัยค่ะ ตอนนี้ระบบยังไม่สามารถตรวจสอบสถานะอัตโนมัติได้ เดี๋ยวส่งต่อให้แอดมินช่วยตรวจสอบให้นะคะ';
  }

  askFirstName(): string {
    return 'เริ่มสมัครสมาชิกค่ะ กรุณาพิมพ์ชื่อจริงของคุณ';
  }

  askLastName(): string {
    return 'กรุณาพิมพ์นามสกุลของคุณ';
  }

  askPhoneNumber(): string {
    return 'กรุณาพิมพ์เบอร์โทรศัพท์ของคุณ';
  }

  askBankName(): string {
    return 'กรุณาพิมพ์ชื่อธนาคาร';
  }

  askBankAccount(): string {
    return 'กรุณาพิมพ์เลขบัญชีธนาคาร';
  }

  invalidPhoneNumber(): string {
    return 'เบอร์โทรไม่ถูกต้อง กรุณาพิมพ์เบอร์โทรศัพท์ 10 หลัก เช่น 0812345678';
  }

  invalidBankAccount(): string {
    return 'เลขบัญชีไม่ถูกต้อง กรุณาพิมพ์เฉพาะตัวเลข 10-12 หลัก';
  }

  confirmRegister(data: {
    firstName: string;
    lastName: string;
    phoneNumber: string;
    bankName: string;
    bankAccount: string;
  }): string {
    return [
      'กรุณาตรวจสอบข้อมูล',
      '',
      `ชื่อ: ${data.firstName}`,
      `นามสกุล: ${data.lastName}`,
      `เบอร์โทร: ${data.phoneNumber}`,
      `ธนาคาร: ${data.bankName}`,
      `เลขบัญชี: ${data.bankAccount}`,
      '',
      'พิมพ์ "ยืนยัน" เพื่อสมัครสมาชิก',
      'หรือพิมพ์ "ยกเลิก" เพื่อยกเลิก',
    ].join('\n');
  }

  registerSuccess(data: {
    username: string;
    password: string;
    urlWeb: string;
  }): string {
    return [
      'สมัครสมาชิกสำเร็จค่ะ',
      '',
      `Username: ${data.username}`,
      `Password: ${data.password}`,
      `URL: ${data.urlWeb}`,
      '',
      'กรุณาเข้าสู่ระบบและเปลี่ยนรหัสผ่านหลังจาก login ครั้งแรก',
    ].join('\n');
  }

  sendAuthToUser(data: { username: string; password: string }): string {
    return [
      'สมัครสมาชิกสำเร็จค่ะ',
      '',
      `ชื่อผู้ใช้: ${data.username}`,
      `รหัสผ่าน: ${data.password}`,
      `เว็บไซต์: https://my-website.com`,
      '',
      'กรุณาเก็บข้อมูลนี้ไว้สำหรับเข้าสู่ระบบครั้งต่อไป',
    ].join('\n');
  }
}
