-- An image's pixel size, read from its header when stored, so themes can
-- reserve its space. 0 when unknown (images stored before this).
ALTER TABLE media ADD COLUMN width INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media ADD COLUMN height INTEGER NOT NULL DEFAULT 0;
