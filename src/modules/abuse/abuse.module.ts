import { Global, Module } from '@nestjs/common';
import { BanController } from './ban.controller';
import { BanService } from './ban.service';
import { SpamDetectorService } from './spam-detector.service';
import { UserLimitResetService } from './user-limit-reset.service';

@Global()
@Module({
  controllers: [BanController],
  providers: [BanService, SpamDetectorService, UserLimitResetService],
  exports: [BanService, SpamDetectorService, UserLimitResetService],
})
export class AbuseModule {}
