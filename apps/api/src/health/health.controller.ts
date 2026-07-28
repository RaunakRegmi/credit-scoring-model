/**
 * Liveness and readiness.
 *
 * `/healthz` answers "is this process alive" — never touches dependencies, so an orchestrator
 * does not restart a healthy API because the database blipped.
 *
 * `/readyz` answers "can this instance serve traffic". The database is required. The ML
 * service is explicitly NOT: the API is designed to score without it, so reporting unready
 * when the model is down would take down a system that is working as designed.
 */
import { Controller, Get, HttpCode } from '@nestjs/common';
import { CURRENT_FEATURE_SET_VERSION } from '@aics/contracts';

import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { MlScoringClient } from '../scoring/ml-scoring.client';
import { SCORECARD_VERSION } from '../scoring/scorecard.service';
import { PolicyService } from '../policy/policy.service';

interface ReadinessReport {
  readonly status: 'ready' | 'degraded' | 'unavailable';
  readonly database: boolean;
  readonly mlService: {
    readonly reachable: boolean;
    readonly circuit: string;
    readonly modelVersion: string | null;
    readonly provenance: string | null;
  };
  readonly versions: {
    readonly scorecard: string;
    readonly featureSet: string;
    readonly policy: string;
  };
}

/**
 * Both probes are `@Public()`.
 *
 * They have to be: Docker's health check and any orchestrator's readiness probe hold no
 * credential. What they disclose is bounded to component reachability and version strings — no
 * applicant data, no counts, nothing about who has an account. In a bank deployment these are
 * additionally expected to be reachable only from inside the cluster, since the ingress that
 * fronts this API is the thing publishing routes to the internet.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ml: MlScoringClient,
    private readonly policy: PolicyService,
  ) {}

  @Public()
  @Get('healthz')
  @HttpCode(200)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('readyz')
  async readiness(): Promise<ReadinessReport> {
    const [database, mlReachable] = await Promise.all([this.prisma.ping(), this.ml.healthy()]);
    const modelInfo = mlReachable ? await this.ml.modelInfo() : null;

    return {
      // Degraded rather than unavailable when only the model is down: the scorecard still
      // decides, it simply cannot auto-approve.
      status: !database ? 'unavailable' : mlReachable ? 'ready' : 'degraded',
      database,
      mlService: {
        reachable: mlReachable,
        circuit: this.ml.circuitState().state,
        modelVersion: modelInfo?.modelVersion ?? null,
        provenance: modelInfo?.provenance ?? null,
      },
      versions: {
        scorecard: SCORECARD_VERSION,
        featureSet: CURRENT_FEATURE_SET_VERSION,
        policy: this.policy.current.version,
      },
    };
  }
}
