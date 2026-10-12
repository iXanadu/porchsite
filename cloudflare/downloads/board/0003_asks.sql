-- The public request form (/ask on porchsite.dev and get.porchsite.dev):
-- features, looks, bug reports and anything else, from people who don't use
-- an assistant. Read only by the curator; nothing here is ever published.
-- Run once, BEFORE deploying the board code that writes this table: each
-- statement with `wrangler d1 execute <board database> --remote
-- --command "..."` (--file uses D1's import API, which needs a token
-- permission the deploy token may lack).
-- kind: feature | look | broken | other.
-- x: an X handle to reply to ('' for none); the form collects no other contact.
-- visitor: sha256 of a daily salt and the sender's address, for the daily
-- limit only; never the address itself, and blanked after two days.
-- state: new | seen | planned | done | declined | spam; note: the curator's.
CREATE TABLE IF NOT EXISTS board_asks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, link TEXT NOT NULL DEFAULT '', x TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'new', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS board_asks_visitor ON board_asks (visitor, created_at);
CREATE INDEX IF NOT EXISTS board_asks_state ON board_asks (state, created_at);
