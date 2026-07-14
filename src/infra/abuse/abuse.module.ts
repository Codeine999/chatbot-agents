import { Global, Module } from '@nestjs/common';
import { BanController } from './ban.controller';
import { BanService } from './ban.service';
import { SpamDetectorService } from './spam-detector.service';

@Global()
@Module({
  controllers: [BanController],
  providers: [BanService, SpamDetectorService],
  exports: [BanService, SpamDetectorService],
})
export class AbuseModule {}
