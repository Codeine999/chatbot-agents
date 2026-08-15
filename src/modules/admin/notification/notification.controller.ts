import { Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { NotificationService } from './notification.service';
import {
  ListNotificationsQueryDto,
  NotificationIdParamDto,
} from './dto/notification.dto';

@AdminGuard()
@Controller('api/admin/notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  list(@Query() query: ListNotificationsQueryDto) {
    return this.notificationService.list(query.unreadOnly);
  }

  @Get('unread-count')
  async unreadCount() {
    return { count: await this.notificationService.getUnreadCount() };
  }

  @Patch(':id/read')
  markAsRead(@Param() params: NotificationIdParamDto) {
    return this.notificationService.markAsRead(params.id);
  }

  @Patch('read-all')
  async markAllAsRead() {
    await this.notificationService.markAllAsRead();
    return { success: true };
  }
}
