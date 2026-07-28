/**
 * Seeds the three reference applicants and scores each one end to end.
 *
 * Runs the real pipeline — extraction, classification, aggregation, feature engineering,
 * scorecard, decision, persistence — rather than inserting pre-computed scores. That is the
 * point: after `npm run db:seed` the database contains three assessments whose bands can be
 * checked against the §5.1 table, and any regression in parsing or scoring shows up here
 * before it reaches a UI.
 *
 * The ML service is optional. If it is not running, each application picks up an
 * `ML_SERVICE_UNAVAILABLE` flag and is referred rather than auto-approved — which is itself
 * worth seeing, since it is the degradation path in §4 of the brief.
 */
import '../src/load-env';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { APP_CONFIG, type AppConfig } from '../src/config/configuration';
import { CreditAssessmentService } from '../src/credit-assessment/credit-assessment.service';
import { PrismaService } from '../src/prisma/prisma.service';

import { FIXTURE_PROFILES } from './fixtures/generate-fixtures';
import { seedBootstrapAdmin } from './seed-staff';

import type { DocumentType, ResidenceStatus } from '@aics/contracts';

const logger = new Logger('Seed');

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const assessments = app.get(CreditAssessmentService);
  const prisma = app.get(PrismaService);
  const config = app.get<AppConfig>(APP_CONFIG);

  try {
    // Before the fixtures: without a staff account nobody can sign in to look at what follows.
    await seedBootstrapAdmin(prisma, config, logger);

    // Idempotent: clear prior fixture data so re-seeding does not accumulate applicants.
    // Cascades from `Applicant` remove applications, documents, scores and audit rows.
    const fixtureHashes = FIXTURE_PROFILES.map((profile) =>
      prisma.pii.lookupHash(profile.nationalId),
    );
    const removed = await prisma.db.applicant.deleteMany({
      where: { nidHash: { in: fixtureHashes } },
    });
    if (removed.count > 0) {
      logger.log(`Removed ${removed.count} existing fixture applicant(s)`);
    }

    const summary: {
      label: string;
      arn: string;
      score: number;
      band: string;
      decision: string;
      limit: string;
      expected: string;
      degraded: string;
    }[] = [];

    for (const profile of FIXTURE_PROFILES) {
      logger.log(`--- ${profile.label} ---`);

      const { id, arn } = await assessments.createApplication({
        productType: profile.productType,
        requestedAmountNpr: profile.requestedAmountNpr,
        tenureMonths: profile.tenureMonths,
        applicant: {
          fullName: profile.fullName,
          fatherName: profile.fatherName,
          email: profile.email,
          phone: profile.phone,
          nationalId: profile.nationalId,
          nationality: profile.nationality,
          currentAddress: profile.address,
          yearsAtAddress: profile.yearsAtAddress,
        },
        consent: {
          dataProcessing: true,
          creditBureauPull: true,
          automatedAssessment: true,
        },
      });

      // KYC and bureau facts that arrive from systems outside the uploaded documents.
      await prisma.db.loanApplication.update({
        where: { id },
        data: { activeLoanCount: profile.activeLoanCount },
      });
      await prisma.db.applicant.update({
        where: { nidHash: prisma.pii.lookupHash(profile.nationalId) },
        data: {
          nidVerificationStatus: profile.nidVerified ? 'VERIFIED' : 'FAILED',
          kycFaceMatchScore: profile.kycFaceMatchScore,
          kycVerified: profile.nidVerified,
          residenceStatus: profile.residenceStatus,
        },
      });

      const result = await assessments.processDocumentUpload(
        id,
        {
          buffer: Buffer.from(profile.resumeText, 'utf8'),
          originalname: `${profile.key}-resume.txt`,
          mimetype: 'text/plain',
          size: Buffer.byteLength(profile.resumeText),
        },
        {
          buffer: Buffer.from(profile.statementCsv, 'utf8'),
          originalname: `${profile.key}-statement.csv`,
          mimetype: 'text/csv',
          size: Buffer.byteLength(profile.statementCsv),
        },
        {
          kycDocuments: profile.kycDocuments as readonly DocumentType[],
          residenceStatus: profile.residenceStatus as ResidenceStatus,
        },
      );

      for (const pillar of result.pillars) {
        logger.log(
          `  ${pillar.pillar.padEnd(13)} ${pillar.points.toFixed(0).padStart(4)} / ${pillar.maxPoints}`,
        );
      }

      summary.push({
        label: profile.label,
        arn,
        score: result.compositeScore,
        band: result.riskBand,
        decision: result.decision,
        limit:
          result.offer === null
            ? '—'
            : `NPR ${result.offer.approvedLimitNpr.toLocaleString('en-IN')} @ ${(
                result.offer.monthlyInterestRate * 100
              ).toFixed(2)}%/mo`,
        expected: profile.expectedBand,
        degraded: result.degraded ? result.degradedFlags.join(', ') : '—',
      });
    }

    logger.log('');
    logger.log('='.repeat(100));
    logger.log('SEEDED ASSESSMENTS');
    logger.log('='.repeat(100));
    for (const row of summary) {
      logger.log(`${row.label}  [${row.arn}]`);
      logger.log(
        `  score ${row.score.toFixed(0)}/1000 · ${row.band} · ${row.decision} · ${row.limit}`,
      );
      logger.log(`  expected band: ${row.expected}`);
      logger.log(`  degraded: ${row.degraded}`);
    }
    logger.log('='.repeat(100));
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  logger.error(
    `Seed failed: ${error instanceof Error ? error.message : String(error)}`,
    error instanceof Error ? error.stack : undefined,
  );
  process.exit(1);
});
