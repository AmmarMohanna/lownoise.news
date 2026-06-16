CREATE TABLE IF NOT EXISTS briefing_stars (
  briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (briefing_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_briefing_stars_briefing ON briefing_stars(briefing_id);

UPDATE briefings
SET stars = (
  SELECT COUNT(*)
  FROM briefing_stars
  WHERE briefing_stars.briefing_id = briefings.id
);
