import { Body, Controller, Get, Put } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { PipelineSwitchService } from '../../conversation/message/pipeline-switch.service';

class SetPipelinePausedDto extends createZodDto(
  z.object({ paused: z.boolean() }).strict(),
) {}

/** Global answering switch. Affects every tenant, so dev-only. */
@AdminGuard('dev', 'owner')
@Controller('/api/admin/chat-pipeline')
export class AdminChatPipelineController {
  constructor(private readonly pipelineSwitch: PipelineSwitchService) {}

  @Get()
  get() {
    return this.pipelineSwitch.getState();
  }

  @Put()
  set(@Body() body: SetPipelinePausedDto) {
    return this.pipelineSwitch.setPaused(body.paused);
  }
}
