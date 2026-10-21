import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class PreviewSessionIdParamDto extends createZodDto(
  z.object({
    sessionId: z.string().uuid(),
  }),
) {}

/**
 * One customer turn typed from the back office. Limits mirror what LINE
 * itself accepts (5,000-character text, 300-character postback data); the
 * chatbot's own AI length policy still applies on top, exactly as for LINE.
 */
export class SendPreviewMessageDto extends createZodDto(
  z.object({
    /** Stable across HTTP retries so one user action is charged once. */
    clientRequestId: z.string().uuid(),
    text: z.string().trim().min(1).max(5_000),
    /** Simulates a rich menu tap; unknown values are ignored by the router. */
    postbackData: z.string().trim().min(1).max(300).optional(),
  }),
) {}
