CREATE TABLE "sys_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "sys_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sys_categories_name_key" ON "sys_categories"("name");

INSERT INTO "sys_categories" ("id", "name")
SELECT gen_random_uuid(), TRIM("category")
FROM "AnswerPattern"
WHERE "category" IS NOT NULL AND TRIM("category") <> ''
GROUP BY TRIM("category")
ON CONFLICT ("name") DO NOTHING;
