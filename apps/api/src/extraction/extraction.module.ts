import { Logger, Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/configuration';

import { DOCUMENT_EXTRACTOR } from './document-extractor.port';
import { LlamaParseDocumentExtractor } from './llamaparse-document.extractor';
import { LocalDocumentExtractor } from './local-document.extractor';

/**
 * Selects the extraction adapter from configuration.
 *
 * One decision, made once at boot and logged, rather than a branch at every call site.
 * Everything downstream depends only on `DOCUMENT_EXTRACTOR`.
 */
@Module({
  providers: [
    LocalDocumentExtractor,
    {
      provide: DOCUMENT_EXTRACTOR,
      inject: [APP_CONFIG, LocalDocumentExtractor],
      useFactory: (config: AppConfig, local: LocalDocumentExtractor) => {
        const logger = new Logger('ExtractionModule');

        if (config.extraction.llamaApiKey === null) {
          logger.log(
            'Using the built-in local document extractor (no LLAMA_CLOUD_API_KEY set). ' +
              'Text-layer PDF, DOCX and CSV are supported; scanned images will be routed to ' +
              'manual review.',
          );
          return local;
        }

        logger.log('Using the LlamaParse extractor, with the local extractor as fallback.');
        return new LlamaParseDocumentExtractor(
          {
            apiKey: config.extraction.llamaApiKey,
            baseUrl: config.extraction.llamaBaseUrl,
          },
          local,
        );
      },
    },
  ],
  exports: [DOCUMENT_EXTRACTOR],
})
export class ExtractionModule {}
