ALTER TABLE briefings ADD COLUMN stars INTEGER NOT NULL DEFAULT 0;
UPDATE briefings
SET stars = CASE
  WHEN stars = 0 AND COALESCE(starred, 0) > 0 THEN 1
  ELSE stars
END;
