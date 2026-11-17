-- CreateEnum
CREATE TYPE "LineMemberGrade" AS ENUM ('NORMAL', 'VIP', 'VVIP', 'ELITE');

-- AlterTable
ALTER TABLE "lineMember" ADD COLUMN     "grade" "LineMemberGrade" NOT NULL DEFAULT 'NORMAL';
