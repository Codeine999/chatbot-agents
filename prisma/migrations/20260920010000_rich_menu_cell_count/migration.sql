-- How many cells a menu image is divided into.
--
-- The previous migration left this to be inferred from the number of areas,
-- which is wrong the moment a cell is decorative: such a cell has no area, so
-- a six-cell menu with three buttons read back as a three-cell menu and its
-- later cells became unreachable. Existing rows stay NULL and keep the old
-- inference, which is correct for them because every cell they have is a button.
ALTER TABLE "richMenuTemplate"
  ADD COLUMN "cellCount" INTEGER;
