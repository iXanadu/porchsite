-- Disposable public representations. Authorization remains live on every hit.
CREATE TABLE public_artifact_state (
 id INTEGER PRIMARY KEY,
 generation TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 0,
 preparing TEXT NOT NULL DEFAULT '',
 prepare_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO public_artifact_state(id) VALUES(1);
CREATE TABLE public_artifacts (
 key TEXT PRIMARY KEY,
 generation TEXT NOT NULL,
 body TEXT NOT NULL,
 metadata TEXT NOT NULL,
 valid_until INTEGER NOT NULL,
 size INTEGER NOT NULL
);
