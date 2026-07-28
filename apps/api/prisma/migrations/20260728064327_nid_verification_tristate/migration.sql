-- Replace the `nidVerified` boolean with a tri-state verification status.
--
-- The boolean conflated two different facts: "verification has not run yet" and "verification
-- ran and failed". §5.3 declines a failed check, so under the boolean model every newly created
-- applicant was declined before the KYC pipeline had any chance to execute.

CREATE TYPE "KycVerificationStatus" AS ENUM ('NOT_ATTEMPTED', 'VERIFIED', 'FAILED');

ALTER TABLE "applicant_profile"
  ADD COLUMN "nidVerificationStatus" "KycVerificationStatus" NOT NULL DEFAULT 'NOT_ATTEMPTED';

-- Preserve what the old column actually told us. `true` unambiguously meant verified.
UPDATE "applicant_profile"
  SET "nidVerificationStatus" = 'VERIFIED'
  WHERE "nidVerified" = true;

-- `false` is not migrated to FAILED. Under the old model it could mean either "not checked" or
-- "checked and failed", and NOT_ATTEMPTED is the correct reading of ambiguous evidence: it holds
-- the application for human review instead of declining on a finding we cannot prove we made.

ALTER TABLE "applicant_profile" DROP COLUMN "nidVerified";
