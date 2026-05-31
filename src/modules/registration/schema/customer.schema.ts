import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, HydratedDocument } from 'mongoose';

export enum RegisterStatus {
  PENDING = 'pending',
  READY = 'ready',
  PROCESSING = 'processing',
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Schema({
  timestamps: true,
  collection: 'customers',
})
export class Customer extends Document {

  @Prop({
    trim: true,
  })
  username?: string;

  @Prop({
    select: false,
  })
  password?: string;

  @Prop({
    trim: true,
    lowercase: true,
  })
  email?: string;

  @Prop({
    trim: true,
  })
  phone?: string;

  @Prop({
    trim: true,
  })
  name?: string;

  @Prop({
    trim: true,
  })
  lastName?: string;

  @Prop({
    type: Date,
  })
  birthDay?: Date;

  @Prop({
    trim: true,
  })
  bankBrand?: string;

  @Prop({
    trim: true,
  })
  bankName?: string;

  @Prop({
    trim: true,
    select: false,
  })
  bankNumber?: string;

  @Prop({
    enum: Object.values(RegisterStatus),
    default: RegisterStatus.PENDING,
    index: true,
  })
  registerStatus!: RegisterStatus;
}

export type CustomerDocument = HydratedDocument<Customer>;
export const CustomerSchema = SchemaFactory.createForClass(Customer);

CustomerSchema.index(
  {
    phone: 1,
  },
  {
    unique: true,
    sparse: true,
  },
);

CustomerSchema.index(
  {
    email: 1,
  },
  {
    unique: true,
    sparse: true,
  },
);

CustomerSchema.index(
  {
    username: 1,
  },
  {
    unique: true,
    sparse: true,
  },
);

CustomerSchema.index(
  {
    bankNumber: 1,
  },
  {
    unique: true,
    sparse: true,
  },
);
