import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, loadConfig } from './configuration';

/**
 * Provides the validated `AppConfig` to the whole application.
 *
 * Must be its own `@Global()` module rather than a provider on `AppModule`: Nest resolves
 * dependencies upward from the module that declares them, so a provider on `AppModule` is
 * invisible to the modules `AppModule` imports. Every module needing configuration would
 * otherwise have to import it explicitly.
 *
 * Parsed exactly once, at boot. If the environment is invalid the factory throws and the
 * process never starts serving — which is the only safe outcome for a service that decides
 * credit and encrypts national IDs.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
