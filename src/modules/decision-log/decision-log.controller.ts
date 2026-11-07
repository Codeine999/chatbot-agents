import { Controller, Get, Param, Query } from '@nestjs/common';
import { AdminGuard } from '../../shared/guards/admin-guard.decorator';
import { DecisionLogQueryService } from './decision-log-query.service';
import {
  DecisionLogIdParamDto,
  DecisionLogSummaryQueryDto,
  ListDecisionLogsQueryDto,
} from './dto/decision-log-query.dto';

/** Customer messages are in these rows, so only owners and devs may read them. */
@AdminGuard('dev', 'owner')
@Controller('api/admin/decision-logs')
export class DecisionLogController {
  constructor(private readonly logs: DecisionLogQueryService) {}

  /** Newest first; pass `nextCursor` back as `cursor` for the next page. */
  @Get()
  list(@Query() query: ListDecisionLogsQueryDto) {
    return this.logs.list(query);
  }

  /** Counts, fallback reasons and the similarity histogram for tuning. */
  @Get('summary')
  summary(@Query() query: DecisionLogSummaryQueryDto) {
    return this.logs.summary(query);
  }

  /** One turn with its full stage trace and candidates. */
  @Get(':id')
  get(@Param() params: DecisionLogIdParamDto) {
    return this.logs.get(params.id);
  }
}
