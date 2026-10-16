import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../admin/auth/auth.module';
import { CommerceAccessModule } from '../commerce/commerce-access.module';
import { ProductCommandService } from './product-command.service';
import { ProductService } from './product.service';
import { InventoryService } from './inventory.service';
import { ProductAttributeController } from './attributes/product-attribute.controller';
import { ProductAttributeService } from './attributes/product-attribute.service';

@Module({
  imports: [PrismaModule, AuthModule, CommerceAccessModule],
  controllers: [ProductAttributeController],
  providers: [
    ProductCommandService,
    ProductService,
    InventoryService,
    ProductAttributeService,
  ],
  exports: [
    ProductService,
    InventoryService,
    ProductCommandService,
    ProductAttributeService,
  ],
})
export class ProductsModule {}
