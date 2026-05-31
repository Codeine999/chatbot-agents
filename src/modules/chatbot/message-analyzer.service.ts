import { Injectable } from '@nestjs/common';
import {
  CustomerInfoExtractorService,
  ExtractedCustomerInfo,
} from './customer-info-extractor.service';

export type MessageIntent = 'register' | 'unknown';

export interface MessageAnalysisResult {
  intent: MessageIntent;
  extracted: ExtractedCustomerInfo;
  missingFields: string[];
}

@Injectable()
export class MessageAnalyzerService {
  constructor(
    private readonly customerInfoExtractor: CustomerInfoExtractorService,
  ) {}

  analyze(text: string): MessageAnalysisResult {
    const extracted = this.customerInfoExtractor.extract(text);
    const missingFields =
      this.customerInfoExtractor.getMissingFields(extracted);
    const hasRegistrationField = Object.values(extracted).some(Boolean);

    return {
      intent: hasRegistrationField ? 'register' : 'unknown',
      extracted,
      missingFields,
    };
  }
}
