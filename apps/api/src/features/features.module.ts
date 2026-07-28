import { Module } from '@nestjs/common';

import { FeatureEngineeringService } from './feature-engineering.service';

@Module({
  providers: [FeatureEngineeringService],
  exports: [FeatureEngineeringService],
})
export class FeaturesModule {}
