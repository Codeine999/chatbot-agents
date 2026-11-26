import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { AdminGuard } from '../../../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../../../admin/admin-jwt-auth.guard';
import {
  CompleteImportUploadDto,
  CreateImportUploadDto,
  LinkImportThreadDto,
  ListImportThreadsQueryDto,
  PresignImportPartsDto,
  PreviewImportThreadQueryDto,
  StartImportDto,
} from './line-chat-import.dto';
import { LineChatImportService } from './line-chat-import.service';

/**
 * LINE OA chat history import (docs/line-chat-import-plan.md §5).
 * dev/owner only: the backup holds every customer's conversation.
 */
@AdminGuard('dev', 'owner')
@Controller('api/line/admin/chat-imports')
export class LineChatImportController {
  constructor(private readonly imports: LineChatImportService) {}

  @Post('uploads')
  createUpload(
    @Req() request: AdminRequest,
    @Body() body: CreateImportUploadDto,
  ) {
    return this.imports.createUpload(
      adminIdOf(request),
      body.fileName,
      body.fileSize,
    );
  }

  @Post('uploads/:uploadId/parts')
  presignParts(
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Body() body: PresignImportPartsDto,
  ) {
    return this.imports.presignParts(uploadId, body.partNumbers);
  }

  @Post('uploads/:uploadId/complete')
  completeUpload(
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Body() body: CompleteImportUploadDto,
  ) {
    return this.imports.completeUpload(uploadId, body.parts);
  }

  @Post()
  @HttpCode(202)
  start(@Body() body: StartImportDto) {
    return this.imports.start(body.uploadId, body.options);
  }

  @Get()
  list() {
    return this.imports.list();
  }

  @Get('conversations/:conversationId/candidates')
  candidates(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.imports.candidatesForConversation(conversationId);
  }

  @Get('threads/:threadId/preview')
  preview(
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Query() query: PreviewImportThreadQueryDto,
  ) {
    return this.imports.preview(threadId, query.limit);
  }

  @Post('threads/:threadId/link')
  @HttpCode(202)
  link(
    @Req() request: AdminRequest,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() body: LinkImportThreadDto,
  ) {
    return this.imports.link(threadId, body.lineMemberId, adminIdOf(request));
  }

  @Post('threads/:threadId/relink')
  @HttpCode(202)
  relink(
    @Req() request: AdminRequest,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() body: LinkImportThreadDto,
  ) {
    return this.imports.relink(threadId, body.lineMemberId, adminIdOf(request));
  }

  @Post('threads/:threadId/unlink')
  unlink(@Param('threadId', ParseUUIDPipe) threadId: string) {
    return this.imports.unlink(threadId);
  }

  @Get(':batchId')
  get(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.imports.get(batchId);
  }

  @Get(':batchId/threads')
  threads(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Query() query: ListImportThreadsQueryDto,
  ) {
    return this.imports.listThreads(batchId, query);
  }

  @Post(':batchId/cancel')
  cancel(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.imports.cancel(batchId);
  }

  @Delete(':batchId')
  @HttpCode(202)
  remove(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.imports.remove(batchId);
  }
}

function adminIdOf(request: AdminRequest): string {
  const id = request.admin?.id;
  if (!id) throw new Error('AdminGuard let a request through without an admin');
  return id;
}
