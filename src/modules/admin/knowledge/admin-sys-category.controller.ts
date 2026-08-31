import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminSysCategoryService } from './admin-sys-category.service';
import {
  CreateSysCategoryDto,
  SysCategoryIdParamDto,
} from './dto/sys-category.dto';

@AdminGuard()
@Controller('api/admin/knowledge/categories')
export class AdminSysCategoryController {
  constructor(private readonly categoryService: AdminSysCategoryService) {}

  @Get()
  list() {
    return this.categoryService.list();
  }

  @Post()
  create(@Body() body: CreateSysCategoryDto) {
    return this.categoryService.create(body);
  }

  @Delete(':id')
  remove(@Param() params: SysCategoryIdParamDto) {
    return this.categoryService.remove(params.id);
  }
}
