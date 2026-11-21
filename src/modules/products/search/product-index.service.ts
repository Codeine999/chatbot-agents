import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmbeddingService } from '../../ai/embedding/embedding.service';
import { CommerceFeatureService } from '../../commerce/commerce-feature.service';
import { ProductVectorRepository } from './product-vector.repository';
import { buildProductDocument, productDocumentHash } from './product-document';
import { enqueueProductIndex } from './product-index-outbox';
import { rethrowPendingAiUsage } from '../../usage/billing/pending-ai-usage.error';
import {
  productCompanyScope,
  productWhere,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import { ProductCommandService } from '../product-command.service';
import { lockProduct } from '../product-lock';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';
import { loadCatalogFields } from './catalog-fields';

const MAX_BULK_REINDEX = 500;
/** A stable UUID per (batch request, product), so a retried batch replays. */
const derivedRequestId = (requestId: string, productId: string) => {
  const hex = createHash('sha256')
    .update(`reindex:${requestId}:${productId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** DB jobs are the durable outbox. A bounded poller recovers crashes and reindexes model changes. */
@Injectable()
export class ProductIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductIndexService.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
    private readonly vectors: ProductVectorRepository,
    private readonly features: CommerceFeatureService,
    @Optional() private readonly scopes?: CommerceScopeService,
  ) {}

  onModuleInit() {
    if (!this.features.productSemanticEnabled) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async status(scopeInput: CommerceScope) {
    const scope = productCompanyScope(scopeInput);
    const jobs = await this.prisma.productIndexJob.findMany({
      where: {
        companyId: scope.companyId,
        product: { ...productWhere(scope) },
        embeddingModel: this.embeddings.model,
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        productId: true,
        searchRevision: true,
        state: true,
        attempts: true,
        retryAt: true,
        lastErrorCode: true,
      },
    });
    const counts = await this.prisma.productIndexJob.groupBy({
      by: ['state'],
      where: {
        companyId: scope.companyId,
        product: { ...productWhere(scope) },
        embeddingModel: this.embeddings.model,
      },
      _count: { _all: true },
    });
    return {
      embeddingModel: this.embeddings.model,
      semanticEnabled: this.features.productSemanticEnabled,
      counts,
      jobs,
    };
  }

  /**
   * Every ACTIVE product of the company in one call: queues the missing
   * index jobs and retries failed ones (the same rules as `reindex`). `force`
   * also re-embeds products whose current job is already DONE, which bills
   * one embedding each. The background poller does the embedding; this only
   * queues and kicks it once.
   */
  async reindexAll(
    scopeInput: CommerceScope,
    actorId: string,
    requestId: string,
    force: boolean,
    commands: ProductCommandService,
  ) {
    const scope = productCompanyScope(scopeInput);
    this.features.assertCatalogEnabled();
    if (!this.features.productSemanticEnabled)
      throw new ConflictException(
        'Product semantic search is disabled (PRODUCT_SEMANTIC_ENABLED)',
      );
    const products = await this.prisma.product.findMany({
      where: { ...productWhere(scope), status: 'ACTIVE' },
      select: { id: true, revision: true, searchRevision: true },
      orderBy: { id: 'asc' },
      take: MAX_BULK_REINDEX + 1,
    });
    if (products.length > MAX_BULK_REINDEX)
      throw new ConflictException(
        `More than ${MAX_BULK_REINDEX} active products; reindex them one by one`,
      );
    const queued: string[] = [];
    const failed: { productId: string; reason: string }[] = [];
    let requeued = 0;
    for (const product of products) {
      try {
        // One catalog command per product, keyed by the batch id, so a retry
        // of the whole call replays the finished ones.
        await this.reindex(
          scope,
          actorId,
          product.id,
          derivedRequestId(requestId, product.id),
          product.revision,
          commands,
        );
        queued.push(product.id);
        if (force)
          requeued += (
            await this.prisma.productIndexJob.updateMany({
              where: {
                productId: product.id,
                companyId: scope.companyId,
                searchRevision: product.searchRevision,
                embeddingModel: this.embeddings.model,
                state: 'DONE',
              },
              data: {
                state: 'PENDING',
                attempts: 0,
                retryAt: new Date(),
                lastErrorCode: null,
              },
            })
          ).count;
      } catch (error) {
        failed.push({
          productId: product.id,
          reason:
            error instanceof Error ? error.message.slice(0, 200) : 'error',
        });
      }
    }
    void this.tick();
    return {
      embeddingModel: this.embeddings.model,
      requested: products.length,
      queued: queued.length,
      forcedReembed: requeued,
      failed,
    };
  }

  reindex(
    scopeInput: CommerceScope,
    actorId: string,
    productId: string,
    requestId: string,
    expectedVersion: number,
    commands: ProductCommandService,
  ) {
    const scope = productCompanyScope(scopeInput);
    this.features.assertCatalogEnabled();
    return commands.execute(
      scope,
      actorId,
      requestId,
      'REINDEX_PRODUCT',
      { productId, expectedVersion, model: this.embeddings.model },
      async (tx) => {
        const product = await lockProduct(tx, scope, productId);
        if (product.revision !== expectedVersion)
          throw new ConflictException('Product version changed');
        // A job superseded while the product was a draft (or by a changed
        // document) is never picked up again and the enqueue below keeps an
        // existing row, so drop it and let the enqueue write a fresh document.
        await tx.productIndexJob.deleteMany({
          where: {
            productId,
            companyId: scope.companyId,
            searchRevision: product.searchRevision,
            embeddingModel: this.embeddings.model,
            state: 'SUPERSEDED',
          },
        });
        await enqueueProductIndex(
          tx,
          productId,
          scope.companyId,
          this.embeddings.model,
        );
        // Pending billing outcomes require reconciliation, not a new billable generation/key.
        await tx.productIndexJob.updateMany({
          where: {
            productId,
            companyId: scope.companyId,
            searchRevision: product.searchRevision,
            embeddingModel: this.embeddings.model,
            state: 'FAILED',
            NOT: { lastErrorCode: 'PENDING_AI_USAGE' },
          },
          data: {
            state: 'PENDING',
            attempts: 0,
            retryAt: new Date(),
            lastErrorCode: null,
          },
        });
        const job = await tx.productIndexJob.findUniqueOrThrow({
          where: {
            productId_searchRevision_embeddingModel: {
              productId,
              searchRevision: product.searchRevision,
              embeddingModel: this.embeddings.model,
            },
          },
        });
        return {
          productId,
          jobId: job.id,
          state: job.state,
          requiresUsageReview: job.lastErrorCode === 'PENDING_AI_USAGE',
        };
      },
    );
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.scopes) return;
      const scope = await this.scopes.forLineDeployment();
      // Anti-join avoids reprocessing the latest 500 products forever; backfill progresses in batches.
      const missing = await this.prisma.$queryRaw<
        { id: string; companyId: string }[]
      >`
        SELECT p.id, p."companyId" FROM products p WHERE p.status = 'ACTIVE'
        AND p."companyId"=${scope.companyId}::uuid AND NOT EXISTS (SELECT 1 FROM "productIndexJobs" j WHERE j."productId"=p.id
          AND j."searchRevision"=p."searchRevision" AND j."embeddingModel"=${this.embeddings.model})
        ORDER BY p.id LIMIT 20`;
      for (const product of missing) {
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM products WHERE id=${product.id}::uuid AND "companyId"=${product.companyId}::uuid FOR UPDATE`;
          await enqueueProductIndex(
            tx,
            product.id,
            product.companyId,
            this.embeddings.model,
          );
        });
      }
      const jobs = await this.prisma.productIndexJob.findMany({
        where: {
          companyId: scope.companyId,
          product: { ...productWhere(scope) },
          embeddingModel: this.embeddings.model,
          retryAt: { lte: new Date() },
          OR: [
            { state: 'PENDING' },
            { state: 'RUNNING', leaseUntil: { lt: new Date() } },
          ],
        },
        take: 10,
        orderBy: { createdAt: 'asc' },
      });
      for (const job of jobs) await this.process(job.id);
    } catch (error) {
      this.logger.warn(
        `Product indexing deferred (${error instanceof Error ? error.name : 'error'})`,
      );
    } finally {
      this.busy = false;
    }
  }

  async process(id: string) {
    if (this.scopes) {
      const scope = await this.scopes.forLineDeployment();
      if (
        !(await this.prisma.productIndexJob.findFirst({
          where: {
            id,
            companyId: scope.companyId,
            product: { ...productWhere(scope) },
          },
          select: { id: true },
        }))
      )
        return;
    }
    const owner = randomUUID();
    const claimed = await this.prisma.productIndexJob.updateMany({
      where: {
        id,
        retryAt: { lte: new Date() },
        OR: [
          { state: 'PENDING' },
          { state: 'RUNNING', leaseUntil: { lt: new Date() } },
        ],
      },
      data: {
        state: 'RUNNING',
        leaseOwner: owner,
        leaseUntil: new Date(Date.now() + 120000),
        attempts: { increment: 1 },
        lastErrorCode: null,
      },
    });
    if (!claimed.count) return;
    const job = await this.prisma.productIndexJob.findUniqueOrThrow({
      where: { id },
    });
    try {
      const product = await this.prisma.product.findFirstOrThrow({
        where: { id: job.productId, companyId: job.companyId },
        include: {
          company: { select: { productBusinessType: true } },
          variants: true,
        },
      });
      if (
        product.status !== 'ACTIVE' ||
        product.searchRevision !== job.searchRevision ||
        job.embeddingModel !== this.embeddings.model
      ) {
        await this.prisma.productIndexJob.updateMany({
          where: { id, leaseOwner: owner },
          data: { state: 'SUPERSEDED', leaseOwner: null, leaseUntil: null },
        });
        return;
      }
      const embedding = await this.embeddings.embedDocument(job.document, {
        turnId: `product-index:${id}:${job.embeddingModel}`,
      });
      if (embedding.model !== job.embeddingModel)
        throw new Error('Embedding model changed');
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM products WHERE id=${job.productId}::uuid AND "companyId"=${job.companyId}::uuid FOR UPDATE`;
        const current = await tx.product.findFirstOrThrow({
          where: { id: job.productId, companyId: job.companyId },
          include: {
            company: { select: { productBusinessType: true } },
            variants: true,
          },
        });
        // Field definitions are part of the document (labels, searchable flags).
        const fresh =
          current.status === 'ACTIVE' &&
          current.searchRevision === job.searchRevision &&
          productDocumentHash(
            buildProductDocument(
              current,
              await loadCatalogFields(tx, {
                companyId: current.companyId,
              }),
            ),
          ) === job.contentHash;
        const owned = await tx.productIndexJob.updateMany({
          where: { id, state: 'RUNNING', leaseOwner: owner },
          data: {
            state: fresh ? 'DONE' : 'SUPERSEDED',
            leaseOwner: null,
            leaseUntil: null,
          },
        });
        if (!owned.count) return;
        if (fresh) await this.vectors.upsert(tx, job, embedding.values);
      });
    } catch (error) {
      // A pending billable result is quarantined; never retry an uncertain provider acceptance.
      let pending = false;
      try {
        rethrowPendingAiUsage(error);
      } catch {
        pending = true;
      }
      await this.prisma.productIndexJob.updateMany({
        where: { id, leaseOwner: owner },
        data: {
          state: pending || job.attempts >= 5 ? 'FAILED' : 'PENDING',
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode: pending
            ? 'PENDING_AI_USAGE'
            : error instanceof Error
              ? error.name.slice(0, 100)
              : 'INDEXING_ERROR',
          retryAt: new Date(
            Date.now() + Math.min(300000, 5000 * 2 ** job.attempts),
          ),
        },
      });
    }
  }
}
