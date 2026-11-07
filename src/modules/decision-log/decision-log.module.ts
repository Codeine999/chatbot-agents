import { Global, Module } from '@nestjs/common';
import { CompanyModule } from '../admin/company/company.module';
import { DecisionLogController } from './decision-log.controller';
import { DecisionLogQueryService } from './decision-log-query.service';
import { DecisionLogService } from './decision-log.service';
import { DecisionTraceService } from './decision-trace.service';
import { DecisionTurnRecorder } from './decision-turn.recorder';

/**
 * Per-turn decision log. Global because tracing is cross-cutting: chatbot,
 * retrieval, provider and messaging services record into it through an
 * optional injection, without importing this module or changing their own
 * module graphs.
 */
@Global()
@Module({
  imports: [CompanyModule],
  controllers: [DecisionLogController],
  providers: [
    DecisionTraceService,
    DecisionLogService,
    DecisionLogQueryService,
    DecisionTurnRecorder,
  ],
  exports: [DecisionTraceService, DecisionLogService, DecisionTurnRecorder],
})
export class DecisionLogModule {}
