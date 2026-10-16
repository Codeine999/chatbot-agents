import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  productCompanyScope,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import { EMBEDDING_DIMENSIONS } from '../../../infra/embedding/embedding-adapter.interface';

export function productVectorLiteral(values: readonly number[]): string {
  if (
    values.length !== EMBEDDING_DIMENSIONS ||
    values.some((v) => !Number.isFinite(v)) ||
    !values.some((v) => v !== 0)
  )
    throw new Error('Invalid product embedding');
  return `[${values.join(',')}]`;
}

@Injectable()
export class ProductVectorRepository {
  constructor(private readonly prisma: PrismaService) {}

  search(
    scope: CommerceScope,
    language: string,
    values: readonly number[],
    model: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    productCompanyScope(scope);
    const literal = productVectorLiteral(values);
    return db.$queryRaw<
      { productId: string; score: number; searchRevision: number }[]
    >(Prisma.sql`
      SELECT p.id AS "productId", p."searchRevision",
        (1 - (v.embedding <=> ${literal}::vector))::float8 AS score
      FROM "productVectors" v JOIN products p ON p.id = v."productId" AND p."companyId" = v."companyId"
      WHERE p."companyId" = ${scope.companyId}::uuid
        AND p.language = ${language} AND p.status = 'ACTIVE'
        AND v."embeddingModel" = ${model} AND v."searchRevision" = p."searchRevision"
        AND EXISTS (SELECT 1 FROM "productVariants" pv WHERE pv."productId" = p.id AND pv."companyId" = p."companyId" AND pv.active)
      ORDER BY v.embedding <=> ${literal}::vector, p.id LIMIT 20
    `);
  }

  async upsert(
    tx: Prisma.TransactionClient,
    job: {
      productId: string;
      companyId: string;
      searchRevision: number;
      embeddingModel: string;
      contentHash: string;
    },
    values: readonly number[],
  ) {
    const literal = productVectorLiteral(values);
    await tx.$executeRaw`
      INSERT INTO "productVectors" ("productId", "companyId", embedding, "embeddingModel", "searchRevision", "contentHash")
      VALUES (${job.productId}::uuid, ${job.companyId}::uuid, ${literal}::vector, ${job.embeddingModel}, ${job.searchRevision}, ${job.contentHash})
      ON CONFLICT ("productId") DO UPDATE SET embedding=EXCLUDED.embedding,
        "embeddingModel"=EXCLUDED."embeddingModel", "searchRevision"=EXCLUDED."searchRevision",
        "contentHash"=EXCLUDED."contentHash", "updatedAt"=CURRENT_TIMESTAMP`;
  }
}
