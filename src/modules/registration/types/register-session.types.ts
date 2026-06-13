export interface CompleteRegisterSessionData {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  bankName: string;
  bankAccount: string;
}

export interface RegisterAuthData {
  username: string;
}

export type RegisterSessionData = Partial<
  CompleteRegisterSessionData & RegisterAuthData
>;

export enum RegisterStep {
  WAITING_REGISTER_FORM = 'WAITING_REGISTER_FORM',
  SEND_REGISTER_FORM = 'SEND_REGISTER_FORM',
  CURRENT_REGISTER = 'CURRENT_REGISTER',
  PENDING_REGISTER = 'PENDING_REGISTER',
}
