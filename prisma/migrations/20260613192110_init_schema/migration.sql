-- CreateTable
CREATE TABLE "Member" (
    "uuid" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "firstname" TEXT NOT NULL,
    "lastname" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "bankname" TEXT NOT NULL,
    "banknumber" TEXT NOT NULL,
    "statusaccount" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "Member_pkey" PRIMARY KEY ("uuid")
);

-- CreateIndex
CREATE UNIQUE INDEX "Member_username_key" ON "Member"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Member_phone_key" ON "Member"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Member_banknumber_key" ON "Member"("banknumber");
