import { Module } from '@nestjs/common';

import { DecisionService } from './decision.service';
import { MlScoringClient } from './ml-scoring.client';
import { OverrideRuleEngine } from './override-rule.engine';
import { ScorecardService } from './scorecard.service';

@Module({
  providers: [ScorecardService, MlScoringClient, OverrideRuleEngine, DecisionService],
  exports: [ScorecardService, MlScoringClient, OverrideRuleEngine, DecisionService],
})
export class ScoringModule {}
