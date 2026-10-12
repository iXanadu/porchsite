-- Share cards (SPEC §5): the picture a link to an entry shows when shared,
-- its photo with its title over it. The owner's browser draws one for each
-- published entry whose card is missing or older than the entry, and stores
-- it as an image; this says which image is which entry's, at which version.
CREATE TABLE share_cards (
  item_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
