import { Logger } from '@nestjs/common';

// Services log every routing stage at DEBUG; keep test output readable.
Logger.overrideLogger(false);
