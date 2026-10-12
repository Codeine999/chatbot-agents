-- Invalidate derived documents after switching physical field metadata to code presets.
UPDATE products p
SET "searchRevision" = p."searchRevision" + 1
FROM company c
WHERE p."companyId" = c.id
  AND c."productBusinessType" IN ('FASHION', 'RESTAURANT', 'HOTEL');
