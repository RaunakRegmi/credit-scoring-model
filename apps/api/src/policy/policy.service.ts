/**
 * Credit policy loading and rule evaluation.
 *
 * Policy is data, not code. `apps/api/policy/scoring-policy.json` is the live file;
 * `DEFAULT_SCORING_POLICY` in `@aics/contracts` is the fallback. Both are validated
 * against the same zod schema, so an invalid edit degrades to the shipped defaults with a
 * loud warning rather than starting the engine with half-parsed thresholds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_SCORING_POLICY,
  type RuleEvaluation,
  type ScoringPolicy,
  scoringPolicySchema,
} from '@aics/contracts';

/** Rule identifier for the nationality adjustment, used in the audit trail. */
export const GEOPOLITICAL_RULE_ID = 'SOP-002-25:geopolitical-nationality-adjustment';

@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);
  private readonly policy: ScoringPolicy;

  constructor() {
    this.policy = this.load();
    this.announce();
  }

  get current(): ScoringPolicy {
    return this.policy;
  }

  private load(): ScoringPolicy {
    // Resolved relative to the compiled file so it works from both `src` (tsx/vitest)
    // and `dist` (production), where the layout differs by one directory level.
    const candidates = [
      resolve(__dirname, '../../policy/scoring-policy.json'),
      resolve(__dirname, '../../../policy/scoring-policy.json'),
      resolve(process.cwd(), 'policy/scoring-policy.json'),
    ];

    for (const path of candidates) {
      if (!existsSync(path)) {
        continue;
      }
      try {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const parsed = scoringPolicySchema.safeParse(raw);

        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ');
          this.logger.error(
            `Policy file at ${path} is invalid (${issues}). Falling back to built-in defaults. ` +
              'FIX THIS — the engine is not running the policy you think it is.',
          );
          return DEFAULT_SCORING_POLICY;
        }

        this.logger.log(`Loaded credit policy v${parsed.data.version} from ${path}`);
        return parsed.data;
      } catch (error) {
        this.logger.error(
          `Could not read policy file at ${path}: ${error instanceof Error ? error.message : error}. ` +
            'Falling back to built-in defaults.',
        );
        return DEFAULT_SCORING_POLICY;
      }
    }

    this.logger.warn(
      'No scoring-policy.json found; using built-in defaults from @aics/contracts.',
    );
    return DEFAULT_SCORING_POLICY;
  }

  /**
   * Logs the policy posture at boot.
   *
   * The nationality rule being enabled is significant enough that it should be visible in
   * startup logs, not discovered by reading a config file.
   */
  private announce(): void {
    const geo = this.policy.geopoliticalAdjustment;
    if (geo.enabled) {
      this.logger.warn(
        '⚠️  GEOPOLITICAL NATIONALITY ADJUSTMENT IS ENABLED. This applies a score penalty ' +
          'based on national origin, which contradicts §10.2 (demographic neutrality) and ' +
          `carries fair-lending exposure. Legal sign-off reference: ${
            geo.legalSignOffReference ?? 'NONE ON RECORD — this should not be running'
          }`,
      );
    } else {
      this.logger.log(
        'Geopolitical nationality adjustment is disabled (§10.2 fair lending). Country risk ' +
          'is handled by AML/CFT sanctions screening only.',
      );
    }
  }

  /**
   * Evaluates the nationality adjustment (SOP-002 step 25).
   *
   * Always returns an evaluation — never `null` — because a rule that was considered and
   * skipped is itself an auditable fact. When the rule is off, the outcome is
   * `SKIPPED_DISABLED` with zero points, which is the evidence Compliance needs that the
   * engine did not price national origin.
   */
  evaluateGeopoliticalAdjustment(nationality: string): RuleEvaluation {
    const rule = this.policy.geopoliticalAdjustment;
    const country = nationality.trim().toUpperCase();

    if (!rule.enabled) {
      return {
        ruleId: GEOPOLITICAL_RULE_ID,
        ruleVersion: this.policy.version,
        outcome: 'SKIPPED_DISABLED',
        pointsApplied: 0,
        detail:
          `Rule disabled by policy; no nationality-based adjustment applied for "${country}". ` +
          rule.fairLendingWarning,
      };
    }

    // A direct country entry beats a group entry — the specific overrides the general.
    const direct = rule.adjustments[country];
    if (typeof direct === 'number') {
      return {
        ruleId: GEOPOLITICAL_RULE_ID,
        ruleVersion: this.policy.version,
        outcome: direct === 0 ? 'NOT_TRIGGERED' : 'APPLIED',
        pointsApplied: direct,
        detail: `Country-specific adjustment for ${country}: ${direct} points.`,
      };
    }

    for (const [groupName, members] of Object.entries(rule.groups)) {
      if (!members.includes(country)) {
        continue;
      }
      const adjustment = rule.adjustments[groupName];
      if (typeof adjustment !== 'number') {
        continue;
      }
      return {
        ruleId: GEOPOLITICAL_RULE_ID,
        ruleVersion: this.policy.version,
        outcome: adjustment === 0 ? 'NOT_TRIGGERED' : 'APPLIED',
        pointsApplied: adjustment,
        detail: `${country} is in group ${groupName}: ${adjustment} points.`,
      };
    }

    return {
      ruleId: GEOPOLITICAL_RULE_ID,
      ruleVersion: this.policy.version,
      outcome: 'NOT_TRIGGERED',
      pointsApplied: 0,
      detail: `No adjustment configured for ${country}.`,
    };
  }
}
