/**
 * Runtime validation and helpers over the generated feature manifest.
 *
 * Everything here derives from `features.generated.ts`, which derives from
 * `feature-set.v1.json`. Nothing about the feature set is written twice.
 */
import { z } from 'zod';

import {
  FEATURE_DEFINITIONS,
  FEATURE_MANIFEST,
  FEATURE_NAMES,
  FEATURE_SET_VERSION,
  type FeatureDefinition,
  type FeatureName,
  type FeaturePillar,
  type FeatureVector,
  type MonotoneDirection,
} from './generated/features.generated';

export {
  FEATURE_DEFINITIONS,
  FEATURE_MANIFEST,
  FEATURE_NAMES,
  FEATURE_SET_VERSION,
  type FeatureDefinition,
  type FeatureName,
  type FeaturePillar,
  type FeatureVector,
  type MonotoneDirection,
};

/**
 * Per-feature schema. Values are clamped rather than rejected: a genuinely enormous
 * balance or a slightly negative savings rate is real data, and refusing to score an
 * application because a value sat outside a modelling range would be the wrong failure.
 * Non-finite values are a different matter — those indicate a computation bug upstream
 * and are rejected loudly.
 */
function schemaFor(definition: FeatureDefinition): z.ZodType<number> {
  return z
    .number({
      required_error: `feature "${definition.name}" is required`,
      invalid_type_error: `feature "${definition.name}" must be a number`,
    })
    .finite(`feature "${definition.name}" must be finite — got Infinity or NaN`)
    .transform((value) => Math.min(definition.max, Math.max(definition.min, value)))
    .transform((value) => (definition.dtype === 'int' ? Math.round(value) : value));
}

/**
 * Validates a complete, dense feature vector. Strict: an unknown key means the caller is
 * on a different manifest version than we are, which is exactly the silent-corruption
 * case this package exists to prevent.
 */
export const featureVectorSchema = z
  .object(
    Object.fromEntries(FEATURE_MANIFEST.map((d) => [d.name, schemaFor(d)])) as Record<
      FeatureName,
      z.ZodType<number>
    >,
  )
  .strict();

export type ValidatedFeatureVector = z.infer<typeof featureVectorSchema>;

/** A vector of manifest defaults. The starting point for feature computation. */
export function defaultFeatureVector(): Record<FeatureName, number> {
  const vector = {} as Record<FeatureName, number>;
  for (const definition of FEATURE_MANIFEST) {
    vector[definition.name] = definition.default;
  }
  return vector;
}

/**
 * Projects a vector onto the canonical column order.
 *
 * This is the function that keeps TypeScript and Python agreeing. The API never sends a
 * bare array — it sends a named object plus `featureSetVersion`, and the ML service
 * rebuilds the array from its own copy of the manifest. This helper exists for local
 * assertions and tests.
 */
export function toOrderedArray(vector: FeatureVector): number[] {
  return FEATURE_NAMES.map((name) => vector[name]);
}

/** Monotonicity constraints in canonical order, as XGBoost expects them. */
export function monotoneConstraints(): MonotoneDirection[] {
  return FEATURE_MANIFEST.map((d) => d.monotone);
}

export function featuresForPillar(pillar: FeaturePillar): readonly FeatureDefinition[] {
  return FEATURE_MANIFEST.filter((d) => d.pillar === pillar);
}

export function isFeatureName(value: string): value is FeatureName {
  return Object.hasOwn(FEATURE_DEFINITIONS, value);
}

/**
 * Plain-language wording for a declined applicant (SOP-003). Falls back to the raw name
 * only if the ML service reports a feature this build does not know about, which the
 * version check should already have caught.
 */
export function adverseActionFor(feature: string): string {
  return isFeatureName(feature)
    ? FEATURE_DEFINITIONS[feature].adverseAction
    : `Factor "${feature}" contributed negatively to your assessment`;
}

export function labelFor(feature: string): string {
  return isFeatureName(feature) ? FEATURE_DEFINITIONS[feature].label : feature;
}
