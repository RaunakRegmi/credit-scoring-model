import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module';
import { CreditAssessmentModule } from './credit-assessment/credit-assessment.module';
import { HealthModule } from './health/health.module';
import { PolicyModule } from './policy/policy.module';
import { PrismaModule } from './prisma/prisma.module';
import { ScoringModule } from './scoring/scoring.module';

@Module({
  imports: [
    // First: everything else depends on validated configuration.
    ConfigModule,
    PrismaModule,
    PolicyModule,
    ScoringModule,
    CreditAssessmentModule,
    HealthModule,
  ],
})
export class AppModule {}
