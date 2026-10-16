import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommerceAccessModule } from '../../commerce/commerce-access.module';
import { ProductsModule } from '../../products/products.module';
import { AdminProductController } from './admin-product.controller';
import { AdminProductService } from './admin-product.service';

@Module({
  imports: [ProductsModule, AuthModule, CommerceAccessModule],
  controllers: [AdminProductController],
  providers: [AdminProductService],
  exports: [AdminProductService],
})
export class AdminProductModule {}
