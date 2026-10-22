import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createAnswerPatternSchema } from '../../../knowledge/dto/admin-answer-pattern.dto';
import { createMicroKnowledgeSchema } from '../../../knowledge/dto/admin-micro-knowledge.dto';

/** Each item embeds through the provider, so one request is kept bounded. */
export const MAX_BULK_KNOWLEDGE_ITEMS = 50;

const bulkOf = <T extends z.ZodType>(item: T) =>
  z.array(item).min(1).max(MAX_BULK_KNOWLEDGE_ITEMS);

export class BulkCreateAnswerPatternDto extends createZodDto(
  bulkOf(createAnswerPatternSchema),
) {}

export class BulkCreateMicroKnowledgeDto extends createZodDto(
  bulkOf(createMicroKnowledgeSchema),
) {}
