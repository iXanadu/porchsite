-- Derived admission state, using only existing daily visitor identities.
CREATE TABLE analytics_visitor_counts (
 day TEXT NOT NULL,
 visitor TEXT NOT NULL,
 views INTEGER NOT NULL CHECK (typeof(views) = 'integer' AND views BETWEEN 0 AND 200),
 PRIMARY KEY (day, visitor)
) WITHOUT ROWID;
