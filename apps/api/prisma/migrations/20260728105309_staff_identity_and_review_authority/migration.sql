-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('UNDERWRITER', 'SENIOR_UNDERWRITER', 'CREDIT_MANAGER', 'COMPLIANCE_OFFICER', 'ADMIN');

-- AlterEnum
ALTER TYPE "ActorType" ADD VALUE 'ADMIN';

-- AlterTable
ALTER TABLE "underwriter_review" ADD COLUMN     "dualAuthByRole" "StaffRole",
ADD COLUMN     "reviewerRole" "StaffRole" NOT NULL DEFAULT 'UNDERWRITER',
ADD COLUMN     "systemDecision" "Decision" NOT NULL DEFAULT 'REFER_UNDERWRITER';

-- CreateTable
CREATE TABLE "staff_user" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "fullName" VARCHAR(200) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "role" "StaffRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_session" (
    "id" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "rotatedToId" UUID,
    "userAgent" VARCHAR(300),
    "ipAddress" VARCHAR(60),

    CONSTRAINT "staff_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_user_email_key" ON "staff_user"("email");

-- CreateIndex
CREATE INDEX "staff_user_role_idx" ON "staff_user"("role");

-- CreateIndex
CREATE INDEX "staff_user_isActive_idx" ON "staff_user"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "staff_session_tokenHash_key" ON "staff_session"("tokenHash");

-- CreateIndex
CREATE INDEX "staff_session_staffUserId_idx" ON "staff_session"("staffUserId");

-- CreateIndex
CREATE INDEX "staff_session_expiresAt_idx" ON "staff_session"("expiresAt");

-- CreateIndex
CREATE INDEX "underwriter_review_reviewedAt_idx" ON "underwriter_review"("reviewedAt");

-- AddForeignKey
ALTER TABLE "staff_session" ADD CONSTRAINT "staff_session_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
