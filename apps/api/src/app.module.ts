import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { CreditAssessmentModule } from './credit-assessment/credit-assessment.module';
import { HealthModule } from './health/health.module';
import { PolicyModule } from './policy/policy.module';
import { PrismaModule } from './prisma/prisma.module';
import { ScoringModule } from './scoring/scoring.module';
import { UnderwriterModule } from './underwriter/underwriter.module';

@Module({
  imports: [
    // First: everything else depends on validated configuration.
    ConfigModule,
    PrismaModule,
    // Registers the global authentication guard. Every route in every module imported below is
    // closed unless it carries an explicit `@Public()`.
    AuthModule,
    PolicyModule,
    ScoringModule,
    CreditAssessmentModule,
    UnderwriterModule,
    HealthModule,
  ],
})
export class AppModule {}
