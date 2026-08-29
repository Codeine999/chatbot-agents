import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const historyStatusSchema = z.enum(['all', 'paid', 'pending', 'failed']);

export class GetBillHistoryQueryDto extends createZodDto(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    status: historyStatusSchema.default('all'),
  }),
) {}
