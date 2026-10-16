import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

@Injectable()
export class CommerceFeatureService {
  readonly catalogEnabled: boolean;
  readonly lineConnectionKey: string;
  readonly productRagEnabled: boolean;
  readonly productSemanticEnabled: boolean;

  constructor(config: ConfigService) {
    const flag = config.get<unknown>('PRODUCT_ENABLED') ?? false;
    if (
      typeof flag !== 'boolean' &&
      (typeof flag !== 'string' || !/^(true|false)$/i.test(flag.trim()))
    ) {
      throw new Error('PRODUCT_ENABLED must be true or false');
    }
    this.catalogEnabled =
      flag === true || String(flag).trim().toLowerCase() === 'true';
    const booleanFlag = (key: string) => {
      const value = config.get<unknown>(key) ?? false;
      if (
        typeof value !== 'boolean' &&
        (typeof value !== 'string' || !/^(true|false)$/i.test(value.trim()))
      )
        throw new Error(`${key} must be true or false`);
      return (
        value === true ||
        (typeof value === 'string' && value.trim().toLowerCase() === 'true')
      );
    };
    this.productRagEnabled =
      this.catalogEnabled && booleanFlag('PRODUCT_RAG_ENABLED');
    this.productSemanticEnabled =
      this.productRagEnabled && booleanFlag('PRODUCT_SEMANTIC_ENABLED');
    this.lineConnectionKey = z
      .string()
      .trim()
      .min(1)
      .max(100)
      .parse(
        config.get<string>('COMMERCE_LINE_CONNECTION_KEY') ?? 'standalone-line',
      );
  }

  assertCatalogEnabled(): void {
    if (!this.catalogEnabled) {
      throw new ForbiddenException('Product catalog is disabled');
    }
  }
}
