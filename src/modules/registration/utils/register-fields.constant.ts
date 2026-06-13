import {
  CompleteRegisterSessionData,
  RegisterSessionData,
} from '../types/register-session.types';

export const REGISTER_REQUIRED_FIELDS: Array<{
  key: keyof CompleteRegisterSessionData;
  label: string;
}> = [
  { key: 'firstName', label: 'ชื่อ' },
  { key: 'lastName', label: 'นามสกุล' },
  { key: 'phoneNumber', label: 'เบอร์โทร' },
  { key: 'bankName', label: 'ชื่อธนาคาร' },
  { key: 'bankAccount', label: 'เลขบัญชี' },
];

export const REGISTER_FIELD_ALIASES: Record<string, keyof RegisterSessionData> =
  {
    ชื่อ: 'firstName',
    firstname: 'firstName',
    นามสกุล: 'lastName',
    lastname: 'lastName',
    เบอร์โทร: 'phoneNumber',
    เบอร์โทรศัพท์: 'phoneNumber',
    โทรศัพท์: 'phoneNumber',
    หมายเลขโทรศัพท์: 'phoneNumber',
    phone: 'phoneNumber',
    phonenumber: 'phoneNumber',
    ชื่อธนาคาร: 'bankName',
    ธนาคาร: 'bankName',
    bank: 'bankName',
    bankname: 'bankName',
    เลขบัญชี: 'bankAccount',
    เลขบัญชีธนาคาร: 'bankAccount',
    บัญชี: 'bankAccount',
    account: 'bankAccount',
    bankaccount: 'bankAccount',
  };

export const REGISTER_BANK_ALIASES: Record<string, string> = {
  กรุงไทย: 'กรุงไทย',
  ktb: 'กรุงไทย',
  กรุงศรี: 'กรุงศรี',
  กรุงศรีอยุธยา: 'กรุงศรี',
  bay: 'กรุงศรี',
  ไทยพาณิช: 'ไทยพาณิชย์',
  ไทยพาณิชย์: 'ไทยพาณิชย์',
  scb: 'ไทยพาณิชย์',
  กสิกร: 'กสิกรไทย',
  กสิกรไทย: 'กสิกรไทย',
  kbank: 'กสิกรไทย',
  กรุงเทพ: 'กรุงเทพ',
  bbl: 'กรุงเทพ',
};
