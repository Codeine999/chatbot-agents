import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const optionalFilter = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

export class GetAllUsersDto extends createZodDto(
  z.preprocess(
    (value) => value ?? {},
    z.object({
      username: optionalFilter,
      firstname: optionalFilter,
      lastname: optionalFilter,
      phone: optionalFilter,
      statusaccount: optionalFilter,
    }),
  ),
) {}
