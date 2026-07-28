import { Global, Module } from '@nestjs/common';

import { PolicyService } from './policy.service';

/** Global: the scorecard, the override engine and the decision engine all read policy. */
@Global()
@Module({
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
