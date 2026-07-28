/**
 * Codegen: `feature-set.v1.json` -> `src/generated/features.generated.ts`
 *
 * The manifest is the source of truth. This script inlines it into a typed TypeScript
 * module so consumers get a literal `FeatureName` union (adding or renaming a feature
 * becomes a compile error at every call site) with no runtime JSON loading, which keeps
 * the package trivially bundleable by Next.js and Nest alike.
 *
 * The Python side reads the same JSON directly (apps/ml/app/manifest.py). Because both
 * derive their column order from one ordered array, train/serve skew is structurally
 * impossible rather than merely unlikely.
 *
 * Run: npm run codegen -w @aics/contracts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MANIFEST_PATH = resolve(__dirname, '../feature-set.v1.json');
const OUTPUT_PATH = resolve(__dirname, '../src/generated/features.generated.ts');

/** Shape of one entry in the manifest's `features` array. */
interface RawFeature {
  readonly name: string;
  readonly label: string;
  readonly dtype: 'int' | 'float';
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly monotone: -1 | 0 | 1;
  readonly pillar: 'FINANCIAL' | 'PROFESSIONAL' | 'SOCIAL' | 'BEHAVIORAL' | 'APPLICATION';
  readonly reasonCode: string;
  readonly adverseAction: string;
}

interface RawManifest {
  readonly version: string;
  readonly scale: string;
  readonly features: readonly RawFeature[];
}

/**
 * Features that would make the model discriminate on a protected characteristic.
 * §10.2 commits the model to demographic neutrality; this check turns that commitment
 * into a build-time failure rather than a policy document nobody reads.
 */
const PROHIBITED_TOKENS = [
  'gender',
  'sex',
  'age',
  'dob',
  'birth',
  'nationality',
  'ethnic',
  'caste',
  'religion',
  'race',
  'marital',
  'disability',
  'pregnan',
];

function validate(manifest: RawManifest): void {
  const errors: string[] = [];

  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    errors.push(`version must be semver, got "${manifest.version}"`);
  }
  if (manifest.features.length === 0) {
    errors.push('manifest declares no features');
  }

  const seen = new Set<string>();
  for (const [index, feature] of manifest.features.entries()) {
    const at = `features[${index}] (${feature.name})`;

    if (!/^[a-z][a-z0-9_]*$/.test(feature.name)) {
      errors.push(`${at}: name must be lower_snake_case`);
    }
    if (seen.has(feature.name)) {
      errors.push(`${at}: duplicate feature name`);
    }
    seen.add(feature.name);

    if (feature.min >= feature.max) {
      errors.push(`${at}: min (${feature.min}) must be < max (${feature.max})`);
    }
    if (feature.default < feature.min || feature.default > feature.max) {
      errors.push(`${at}: default ${feature.default} outside [${feature.min}, ${feature.max}]`);
    }
    if (![-1, 0, 1].includes(feature.monotone)) {
      errors.push(`${at}: monotone must be -1, 0 or 1`);
    }
    if (!feature.adverseAction.trim()) {
      errors.push(`${at}: adverseAction is required — every feature must be explainable to a declined applicant (§6.3)`);
    }

    const lowered = feature.name.toLowerCase();
    const hit = PROHIBITED_TOKENS.find((token) => lowered.includes(token));
    if (hit) {
      errors.push(
        `${at}: name contains "${hit}", which looks like a protected characteristic. ` +
          `§10.2 requires the model to be demographically neutral. If this is a false positive, ` +
          `rename the feature.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid feature manifest:\n  - ${errors.join('\n  - ')}`);
  }
}

function generate(manifest: RawManifest): string {
  const names = manifest.features.map((f) => f.name);

  const definitions = manifest.features
    .map((f) => {
      const escape = (value: string): string => JSON.stringify(value);
      return [
        `  ${f.name}: {`,
        `    name: '${f.name}',`,
        `    label: ${escape(f.label)},`,
        `    dtype: '${f.dtype}',`,
        `    unit: ${escape(f.unit)},`,
        `    min: ${f.min},`,
        `    max: ${f.max},`,
        `    default: ${f.default},`,
        `    monotone: ${f.monotone},`,
        `    pillar: '${f.pillar}',`,
        `    reasonCode: '${f.reasonCode}',`,
        `    adverseAction: ${escape(f.adverseAction)},`,
        `  },`,
      ].join('\n');
    })
    .join('\n');

  return `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source:    packages/contracts/feature-set.v1.json
 * Regenerate: npm run codegen -w @aics/contracts
 *
 * Manifest version ${manifest.version} · ${manifest.features.length} features
 * Model output scale: ${manifest.scale}
 */

/** Pillar a feature belongs to. \`APPLICATION\` features describe the request, not the applicant. */
export type FeaturePillar = 'FINANCIAL' | 'PROFESSIONAL' | 'SOCIAL' | 'BEHAVIORAL' | 'APPLICATION';

/**
 * Monotonicity constraint on P(default), passed straight to XGBoost's
 * \`monotone_constraints\`. Keeping the model monotone in each feature is what makes a
 * gradient-boosted scorecard defensible to a regulator: raising the debt service ratio
 * can never be shown to have lowered the applicant's assessed risk.
 */
export type MonotoneDirection = -1 | 0 | 1;

export interface FeatureDefinition {
  readonly name: FeatureName;
  readonly label: string;
  readonly dtype: 'int' | 'float';
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly monotone: MonotoneDirection;
  readonly pillar: FeaturePillar;
  readonly reasonCode: string;
  /** Plain-language wording used in decline notices (SOP-003) — never the raw feature name. */
  readonly adverseAction: string;
}

export const FEATURE_SET_VERSION = '${manifest.version}' as const;

/**
 * Canonical ordered feature names. THIS ORDER IS THE MODEL'S COLUMN ORDER.
 * Never reorder; append only.
 */
export const FEATURE_NAMES = [
${names.map((n) => `  '${n}',`).join('\n')}
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** A complete, dense model input. Every feature is required — no partial vectors. */
export type FeatureVector = Readonly<Record<FeatureName, number>>;

export const FEATURE_DEFINITIONS: Readonly<Record<FeatureName, FeatureDefinition>> = {
${definitions}
} as const;

/** The manifest in canonical order. */
export const FEATURE_MANIFEST: readonly FeatureDefinition[] = FEATURE_NAMES.map(
  (name) => FEATURE_DEFINITIONS[name],
);
`;
}

function main(): void {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(raw) as RawManifest;

  validate(manifest);

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, generate(manifest), 'utf8');

  process.stdout.write(
    `✓ features.generated.ts — ${manifest.features.length} features @ v${manifest.version}\n`,
  );
}

main();
