CREATE TABLE IF NOT EXISTS content_revision (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 epoch TEXT NOT NULL CHECK (typeof(epoch) = 'text' AND length(epoch) = 32 AND epoch NOT GLOB '*[^0-9a-f]*'),
 n INTEGER NOT NULL CHECK (typeof(n) = 'integer' AND n >= 0)
);

CREATE TRIGGER IF NOT EXISTS content_revision__live__ai
AFTER INSERT ON live FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__live__au
AFTER UPDATE ON live FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__live__ad
AFTER DELETE ON live FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__items__ai
AFTER INSERT ON items FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__items__au
AFTER UPDATE ON items FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__items__ad
AFTER DELETE ON items FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__site_fields__ai
AFTER INSERT ON site_fields FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__site_fields__au
AFTER UPDATE ON site_fields FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__site_fields__ad
AFTER DELETE ON site_fields FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__site_embed_sources__ai
AFTER INSERT ON site_embed_sources FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__site_embed_sources__au
AFTER UPDATE ON site_embed_sources FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__site_embed_sources__ad
AFTER DELETE ON site_embed_sources FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__site_stream_settings__ai
AFTER INSERT ON site_stream_settings FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__site_stream_settings__au
AFTER UPDATE ON site_stream_settings FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__site_stream_settings__ad
AFTER DELETE ON site_stream_settings FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__private_approvals__ai
AFTER INSERT ON private_approvals FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__private_approvals__au
AFTER UPDATE ON private_approvals FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__private_approvals__ad
AFTER DELETE ON private_approvals FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__training_approvals__ai
AFTER INSERT ON training_approvals FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__training_approvals__au
AFTER UPDATE ON training_approvals FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__training_approvals__ad
AFTER DELETE ON training_approvals FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__themes__ai
AFTER INSERT ON themes FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__themes__au
AFTER UPDATE ON themes FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__themes__ad
AFTER DELETE ON themes FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__share_cards__ai
AFTER INSERT ON share_cards FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__share_cards__au
AFTER UPDATE ON share_cards FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__share_cards__ad
AFTER DELETE ON share_cards FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__media__ai
AFTER INSERT ON media FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__media__au
AFTER UPDATE ON media FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

CREATE TRIGGER IF NOT EXISTS content_revision__media__ad
AFTER DELETE ON media FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;

INSERT OR IGNORE INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),0);
