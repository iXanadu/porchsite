-- Credit for shared looks: an X handle and nothing else. Run once on a board
-- made from schema.sql, BEFORE deploying the board code that reads these
-- columns: each statement with `wrangler d1 execute <board database>
-- --remote --command "..."` (--file uses D1's import API, which needs a
-- token permission the deploy token may lack).
-- author_x: the handle the maker claimed ('' for none, or once dropped).
-- claim_code: the one-time code the maker posts on X from that account.
-- credit_verified: NULL not checked yet, 1 the curator saw the post, 0 not
-- credited (unverified, rejected, or credit removed).
ALTER TABLE board_submissions ADD COLUMN author_x TEXT NOT NULL DEFAULT '';
ALTER TABLE board_submissions ADD COLUMN claim_code TEXT NOT NULL DEFAULT '';
ALTER TABLE board_submissions ADD COLUMN credit_verified INTEGER;
