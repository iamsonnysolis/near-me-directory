-- Schema for near-me-directory D1 database
-- Extracted from src/lib/db.ts query patterns

CREATE TABLE IF NOT EXISTS states (
  code TEXT PRIMARY KEY,           -- e.g. "QLD", "NSW"
  name TEXT,                       -- e.g. "Queensland"
  slug TEXT,                       -- e.g. "qld"
  listing_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,             -- region UUID or composite key
  state_code TEXT,
  name TEXT,
  slug TEXT,
  name_clean TEXT,
  listing_count INTEGER DEFAULT 0,
  FOREIGN KEY (state_code) REFERENCES states(code)
);

CREATE TABLE IF NOT EXISTS suburbs (
  id TEXT PRIMARY KEY,
  state_code TEXT,
  name TEXT,
  slug TEXT,
  listing_count INTEGER DEFAULT 0,
  latitude REAL,
  longitude REAL,
  region_slug TEXT,
  FOREIGN KEY (state_code) REFERENCES states(code)
);

CREATE TABLE IF NOT EXISTS listings (
  listing_id TEXT PRIMARY KEY,     -- Google Place ID
  slug TEXT,
  name TEXT,
  address TEXT,
  town TEXT,
  state_code TEXT,
  state TEXT,
  suburb_slug TEXT,
  region_slug TEXT,
  latitude REAL,
  longitude REAL,
  is_open_24h INTEGER DEFAULT 0,
  FOREIGN KEY (state_code) REFERENCES states(code)
);

CREATE TABLE IF NOT EXISTS features (
  listing_id TEXT,
  feature_key TEXT,
  state_code TEXT,
  region_slug TEXT,
  suburb_slug TEXT,
  PRIMARY KEY (listing_id, feature_key),
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id)
);

CREATE TABLE IF NOT EXISTS hours (
  listing_id TEXT,
  day_of_week INTEGER,             -- 0=Sunday ... 6=Saturday
  month_start INTEGER,             -- seasonality (nullable)
  month_end INTEGER,               -- seasonality (nullable)
  open_mins INTEGER,               -- minutes from midnight
  close_mins INTEGER,
  is_open_24h INTEGER DEFAULT 0,
  is_daylight INTEGER DEFAULT 0,
  is_unknown INTEGER DEFAULT 0,
  PRIMARY KEY (listing_id, day_of_week),
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id)
);

CREATE TABLE IF NOT EXISTS notes (
  listing_id TEXT,
  note_type TEXT,
  note TEXT,
  PRIMARY KEY (listing_id, note_type),
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id)
);

CREATE TABLE IF NOT EXISTS content (
  entity_type TEXT,                -- "state", "region", "suburb", "business"
  entity_id TEXT,                  -- state code, region slug, etc.
  content_type TEXT,               -- "about", "local_context", "faq", "tips", etc.
  body TEXT,
  approved INTEGER DEFAULT 1,
  PRIMARY KEY (entity_type, entity_id, content_type)
);

CREATE INDEX IF NOT EXISTS idx_listings_state ON listings(state_code);
CREATE INDEX IF NOT EXISTS idx_listings_region ON listings(region_slug);
CREATE INDEX IF NOT EXISTS idx_listings_suburb ON listings(suburb_slug);
CREATE INDEX IF NOT EXISTS idx_listings_slug ON listings(slug);
CREATE INDEX IF NOT EXISTS idx_features_state ON features(state_code);
CREATE INDEX IF NOT EXISTS idx_features_listing ON features(listing_id);
CREATE INDEX IF NOT EXISTS idx_hours_listing ON hours(listing_id);
CREATE INDEX IF NOT EXISTS idx_suburbs_region ON suburbs(region_slug);
CREATE INDEX IF NOT EXISTS idx_regions_state ON regions(state_code);
