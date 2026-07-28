// Must be first: populates process.env before any other module is evaluated.
import './load-env';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { APP_CONFIG, type AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get<AppConfig>(APP_CONFIG);

  app.useLogger(
    config.isProduction ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'],
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // No global ValidationPipe. Every request body is validated with the zod schemas from
  // `@aics/contracts` inside the controllers, so the API and the dashboard are checked against
  // one shared definition rather than against DTO decorators that could drift from it.
  // Registering Nest's pipe as well would pull in `class-validator` purely to do nothing.

  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.log(`AICS API listening on port ${config.port} (${config.nodeEnv})`);
  logger.log(`ML scoring service: ${config.ml.baseUrl} (timeout ${config.ml.timeoutMs}ms)`);
  logger.log(
    `Document extraction: ${
      config.extraction.llamaApiKey === null ? 'local deterministic parser' : 'LlamaParse'
    }, minimum confidence ${config.extraction.minConfidence}`,
  );
}

void bootstrap().catch((error: unknown) => {
  // Configuration and connection failures land here. Exiting non-zero is correct: a credit
  // engine that cannot validate its own configuration must not accept traffic.
  const logger = new Logger('Bootstrap');
  logger.error(
    `Failed to start: ${error instanceof Error ? error.message : String(error)}`,
    error instanceof Error ? error.stack : undefined,
  );
  process.exit(1);
});
