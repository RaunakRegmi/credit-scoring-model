import { Module } from '@nestjs/common';

import { ExtractionModule } from '../extraction/extraction.module';
import { FeaturesModule } from '../features/features.module';
import { ScoringModule } from '../scoring/scoring.module';
import { StorageModule } from '../storage/storage.module';

import { CreditAssessmentController } from './credit-assessment.controller';
import { CreditAssessmentService } from './credit-assessment.service';

@Module({
  imports: [ExtractionModule, FeaturesModule, ScoringModule, StorageModule],
  controllers: [CreditAssessmentController],
  providers: [CreditAssessmentService],
  exports: [CreditAssessmentService],
})
export class CreditAssessmentModule {}
