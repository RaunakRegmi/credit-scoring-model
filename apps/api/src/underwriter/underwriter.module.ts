import { Module } from '@nestjs/common';

import { CreditAssessmentModule } from '../credit-assessment/credit-assessment.module';

import { UnderwriterController } from './underwriter.controller';
import { UnderwriterService } from './underwriter.service';

/**
 * Imports `CreditAssessmentModule` to reuse its read model rather than re-query the score tables.
 * An underwriter must see the same assessment the applicant-facing view shows; two code paths
 * building that payload is two chances for them to disagree about what was decided.
 */
@Module({
  imports: [CreditAssessmentModule],
  controllers: [UnderwriterController],
  providers: [UnderwriterService],
  exports: [UnderwriterService],
})
export class UnderwriterModule {}
