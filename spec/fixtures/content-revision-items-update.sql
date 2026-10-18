CREATE TRIGGER IF NOT EXISTS content_revision__items__au
AFTER UPDATE ON items FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807 THEN content_revision.n + 1 ELSE 1 END;
END;
