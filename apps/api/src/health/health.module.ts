import { Module } from '@nestjs/common';

import { ScoringModule } from '../scoring/scoring.module';

import { HealthController } from './health.controller';

@Module({
  imports: [ScoringModule],
  controllers: [HealthController],
})
export class HealthModule {}
