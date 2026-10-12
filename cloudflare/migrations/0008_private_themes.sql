-- Where an installed theme came from: the catalog, or made on this site by
-- the assistant (private: only this site has it).
ALTER TABLE themes ADD COLUMN source TEXT NOT NULL DEFAULT 'catalog';
