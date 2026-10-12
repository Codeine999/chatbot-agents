import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AiProviderModule } from '../../ai/ai-provider.module';
import { CommerceAccessModule } from '../../commerce/commerce-access.module';
import { ProductSearchService } from './product-search.service';
import { ProductVectorRepository } from './product-vector.repository';
import { ProductIndexService } from './product-index.service';
import { ProductIndexController } from './product-index.controller';
import { ProductsModule } from '../products.module';

@Module({
  imports: [
    PrismaModule,
    AiProviderModule,
    CommerceAccessModule,
    ProductsModule,
  ],
  controllers: [ProductIndexController],
  providers: [
    ProductSearchService,
    ProductVectorRepository,
    ProductIndexService,
  ],
  exports: [ProductSearchService],
})
export class ProductSearchModule {}
