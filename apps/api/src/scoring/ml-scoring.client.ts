/**
 * Client for the Python scoring microservice.
 *
 * `invokeScoringEngine` from the technical brief. The contract with callers is deliberately
 * narrow: this never throws for an unavailable or slow model. It returns
 * `{ ok: false, flag }`, and the decision engine decides what a missing PD means — which is
 * always "do not auto-approve" (§4 constraint: model timeouts must be handled).
 *
 * That asymmetry is intentional. A network blip must never surface to an applicant as a
 * server error, and it must never quietly approve them either.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CURRENT_FEATURE_SET_VERSION,
  mlModelInfoSchema,
  mlPredictResponseSchema,
  type DegradedFlag,
  type FeatureVector,
  type MlModelInfo,
  type MlPredictResponse,
} from '@aics/contracts';

import {
  CircuitBreaker,
  CircuitOpenError,
  OperationTimeoutError,
  type CircuitSnapshot,
} from '../common/circuit-breaker';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

export type MlScoringOutcome =
  | { readonly ok: true; readonly prediction: MlPredictResponse }
  | { readonly ok: false; readonly flag: DegradedFlag; readonly reason: string };

@Injectable()
export class MlScoringClient {
  private readonly logger = new Logger(MlScoringClient.name);
  private readonly breaker: CircuitBreaker;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.breaker = new CircuitBreaker({
      name: 'ml-scoring',
      timeoutMs: config.ml.timeoutMs,
      failureThreshold: config.ml.failureThreshold,
      resetMs: config.ml.resetMs,
    });
  }

  circuitState(): CircuitSnapshot {
    return this.breaker.snapshot();
  }

  /**
   * Requests a probability of default.
   *
   * The feature-set version travels with the vector and the service rejects a mismatch. That
   * check is the whole point of the shared manifest: a model trained on v1.0.0 columns must
   * never silently score a v1.1.0 vector, because the failure would be an invisible accuracy
   * loss rather than an error.
   */
  async predict(
    applicationRef: string,
    features: FeatureVector,
  ): Promise<MlScoringOutcome> {
    try {
      const prediction = await this.breaker.execute(async (signal) => {
        const response = await fetch(`${this.config.ml.baseUrl}/predict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            featureSetVersion: CURRENT_FEATURE_SET_VERSION,
            applicationRef,
            features,
          }),
          signal,
        });

        if (response.status === 409) {
          const body = await response.text().catch(() => '');
          throw new FeatureVersionMismatchError(body.slice(0, 300));
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`ML service returned ${response.status}: ${body.slice(0, 300)}`);
        }

        const payload: unknown = await response.json();
        // Validate rather than trust. A malformed PD that reaches the decision engine is
        // worse than no PD at all.
        return mlPredictResponseSchema.parse(payload);
      });

      if (prediction.featureSetVersion !== CURRENT_FEATURE_SET_VERSION) {
        this.logger.error(
          `ML service scored against feature set ${prediction.featureSetVersion} but this build ` +
            `computes ${CURRENT_FEATURE_SET_VERSION}. Discarding the prediction.`,
        );
        return {
          ok: false,
          flag: 'ML_FEATURE_VERSION_MISMATCH',
          reason: `Model feature set ${prediction.featureSetVersion} does not match ${CURRENT_FEATURE_SET_VERSION}`,
        };
      }

      return { ok: true, prediction };
    } catch (error) {
      return this.classifyFailure(error, applicationRef);
    }
  }

  /** Model metadata for the health endpoint and the audit record. */
  async modelInfo(): Promise<MlModelInfo | null> {
    try {
      return await this.breaker.execute(async (signal) => {
        const response = await fetch(`${this.config.ml.baseUrl}/model/info`, { signal });
        if (!response.ok) {
          throw new Error(`ML service returned ${response.status}`);
        }
        return mlModelInfoSchema.parse(await response.json());
      });
    } catch (error) {
      this.logger.warn(
        `Could not read ML model info: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.ml.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(Math.min(2000, this.config.ml.timeoutMs)),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Maps a failure to the degraded flag that describes it.
   *
   * The distinction matters downstream and in the KRI dashboard: a timeout suggests the model
   * is overloaded, an open circuit says we already stopped trying, and a version mismatch is
   * a deployment error that needs a human rather than a retry.
   */
  private classifyFailure(error: unknown, applicationRef: string): MlScoringOutcome {
    if (error instanceof FeatureVersionMismatchError) {
      this.logger.error(`[${applicationRef}] ML feature set mismatch: ${error.message}`);
      return {
        ok: false,
        flag: 'ML_FEATURE_VERSION_MISMATCH',
        reason: `Model rejected the feature vector version: ${error.message}`,
      };
    }

    if (error instanceof OperationTimeoutError) {
      this.logger.warn(
        `[${applicationRef}] ML service exceeded ${error.timeoutMs}ms; falling back to scorecard only.`,
      );
      return {
        ok: false,
        flag: 'ML_SERVICE_TIMEOUT',
        reason: `Model did not respond within ${error.timeoutMs}ms`,
      };
    }

    if (error instanceof CircuitOpenError) {
      // Expected, not exceptional: the breaker is doing its job.
      this.logger.warn(
        `[${applicationRef}] ML circuit is open, retrying in ${error.retryAfterMs}ms; ` +
          'falling back to scorecard only.',
      );
      return {
        ok: false,
        flag: 'ML_SERVICE_UNAVAILABLE',
        reason: 'Model circuit breaker is open following repeated failures',
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`[${applicationRef}] ML scoring failed: ${message}`);
    return {
      ok: false,
      flag: 'ML_SERVICE_UNAVAILABLE',
      reason: `Model call failed: ${message}`,
    };
  }
}

class FeatureVersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureVersionMismatchError';
  }
}
