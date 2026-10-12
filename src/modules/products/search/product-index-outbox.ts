import { businessInclude } from '../variant-business';
import { Prisma } from '../../../generated/prisma/client';
import { buildProductDocument, productDocumentHash } from './product-document';
import { loadCatalogFields } from './catalog-fields';

/** Enqueued in the catalog mutation transaction; no network or provider call. */
export async function enqueueProductIndex(
  tx: Prisma.TransactionClient,
  productId: string,
  companyId: string,
  model: string,
): Promise<void> {
  const product = await tx.product.findFirstOrThrow({
    where: { id: productId, companyId },
    include: {
      company: { select: { productBusinessType: true } },
      variants: { include: businessInclude },
    },
  });
  const document = buildProductDocument(
    product,
    await loadCatalogFields(tx, {
      companyId,
    }),
  );
  await tx.productIndexJob.upsert({
    where: {
      productId_searchRevision_embeddingModel: {
        productId,
        searchRevision: product.searchRevision,
        embeddingModel: model,
      },
    },
    update: {},
    create: {
      productId,
      companyId,
      searchRevision: product.searchRevision,
      embeddingModel: model,
      document,
      contentHash: productDocumentHash(document),
    },
  });
}
