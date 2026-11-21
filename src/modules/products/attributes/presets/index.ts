import { ECOMMERCE_PRESET } from './ecommerce.preset';
import { TRANSPORT_PRESET } from './transport.preset';
import { EDUCATION_PRESET } from './education.preset';
import type { BusinessPreset } from '../types/attribute-definition.types';

/**
 * Every business a store can select, keyed by Company.productBusinessType.
 * Read through `search/catalog-fields`, never directly. A new business is a
 * new preset file registered here.
 */
export const BUSINESS_PRESETS: Readonly<Record<string, BusinessPreset>> = {
  ECOMMERCE: ECOMMERCE_PRESET,
  TRANSPORT: TRANSPORT_PRESET,
  EDUCATION: EDUCATION_PRESET,
};
