/**
 * Database utilities for near-me-directory
 * D1-based data fetching with graceful error handling
 * All queries use parameterized SQL on Cloudflare D1
 *
 * NOTE: Table/column names mapped to directory-factory D1 schema:
 *   listings  -> businesses (joined with suburbs/regions/states for town/slugs)
 *   features  -> business_features (joined with businesses for state_code/region/suburb)
 *   hours     -> business_hours (joined with businesses for listing_id)
 *   notes     -> content (filtered by entity_type='business')
 *   listing_count -> business_count (in states/regions/suburbs)
 *   is_open_24h  -> is_24_hours (in businesses)
 *   listing_id    -> id (in businesses)
 */

import { getD1Client, runQuery, runQuerySingle, runCount } from './d1';
import type { D1Database } from '@cloudflare/workers-types';

// Types for database records
export interface ListingRecord {
  listing_id: string;
  slug: string;
  name: string;
  address?: string;
  town?: string;
  state_code?: string;
  suburb_slug?: string;
  region_slug?: string;
  latitude?: number;
  longitude?: number;
  is_open_24h?: boolean;
  opening_hours_note?: string;
}

export interface StateRecord {
  code: string;
  name: string;
  slug: string;
  listing_count?: number;
}

export interface RegionRecord {
  id: string;
  name: string;
  slug: string;
  state_code: string;
  listing_count: number;
  name_clean?: string;
}

export interface SuburbRecord {
  id: string;
  name: string;
  slug: string;
  state_code: string;
  listing_count: number;
  latitude?: number;
  longitude?: number;
  region_slug?: string;
}

export interface FeatureRecord {
  listing_id: string;
  feature_key: string;
}

export interface HourRow {
  day_of_week: number | null;
  month_start: number | null;
  month_end: number | null;
  open_mins: number | null;
  close_mins: number | null;
  is_open_24h: boolean;
  is_daylight: boolean;
  is_unknown: boolean;
}

export interface NoteRecord {
  note_type: string;
  note: string;
}

export interface NearbyListingRecord {
  listing_id: string;
  slug: string;
  name: string;
  suburb?: string;
  suburb_slug?: string;
  region_slug?: string;
  state_code?: string;
  state?: string;
  distance_m: number;
}

export interface ContentRow {
  content_type: string;
  body: string;
}

export interface FeatureCounts {
  accessible?: number;
  open_24h?: number;
  baby_change?: number;
  baby_care_room?: number;
  changing_places?: number;
  dump_point?: number;
  shower?: number;
  parking?: number;
  drinking_water?: number;
}

/**
 * Common join for listings (= businesses with suburb/region/state aliases).
 * Used by fetchListingDetailData and nearby-listings query.
 */
const LISTINGS_JOIN = `
  FROM businesses b
  LEFT JOIN suburbs sub ON b.suburb_id = sub.id
  LEFT JOIN regions r ON b.region_id = r.id
  LEFT JOIN states s ON b.state_code = s.code
`;

const LISTINGS_COLS = `
  b.id AS listing_id, b.slug, b.name, b.address,
  sub.name AS town, sub.name AS suburb,
  b.latitude, b.longitude, b.is_24_hours AS is_open_24h,
  sub.slug AS suburb_slug, r.slug AS region_slug,
  b.state_code, s.name AS state,
  b.google_place_id, b.category, b.is_mobile_service,
  b.is_emergency_service, b.phone, b.website,
  b.opening_hours_raw
`;

/**
 * Fetches all data required for a listing detail page
 * All secondary queries are wrapped in try/catch to prevent build failures
 */
export async function fetchListingDetailData(params: {
  state: string;
  region: string;
  suburb: string;
  listing: string;
}, env?: { DB?: D1Database }) {
  const { state, region, suburb, listing } = params;
  const stateCode = state.toUpperCase();

  const db = await getD1Client(env);

  // Primary fetch - the listing itself
  const listingData = await runQuerySingle(db,
    `SELECT ${LISTINGS_COLS} ${LISTINGS_JOIN} WHERE b.slug = ? AND sub.slug = ? AND r.slug = ? LIMIT 1`,
    [listing, suburb, region]
  );

  if (!listingData || listingData.state_code !== stateCode) {
    return null;
  }

  // Parallel secondary fetches with error handling
  const [stateResult, regionResult, suburbResult] = await Promise.all([
    runQuerySingle(db, 'SELECT code, name, slug FROM states WHERE code = ? LIMIT 1', [stateCode]),
    runQuerySingle(db, 'SELECT id, name, slug, state_code, business_count AS listing_count, name AS name_clean FROM regions WHERE slug = ? AND state_code = ? LIMIT 1', [region, stateCode]),
    runQuerySingle(db, 'SELECT id, name, slug, state_code, business_count AS listing_count FROM suburbs WHERE slug = ? AND state_code = ? LIMIT 1', [suburb, stateCode]),
  ]);

  // Feature, hours, and notes fetch with error handling
  let features: FeatureRecord[] | null = null;
  let hours: HourRow[] | null = null;
  let notes: NoteRecord[] | null = null;
  try {
    [features, hours, notes] = await Promise.all([
      runQuery(db, 'SELECT business_id AS listing_id, feature_key FROM business_features WHERE business_id = ?', [listingData.listing_id]),
      runQuery(db, 'SELECT bh.day_of_week, NULL AS month_start, NULL AS month_end, bh.open_mins, bh.close_mins, b.is_24_hours AS is_open_24h, 0 AS is_daylight, 0 AS is_unknown FROM business_hours bh JOIN businesses b ON bh.business_id = b.id WHERE bh.business_id = ? ORDER BY bh.day_of_week', [listingData.listing_id]),
      runQuery(db, 'SELECT content_type AS note_type, body AS note FROM content WHERE entity_type = ' + "'business' AND entity_id = CAST(? AS TEXT)", [listingData.listing_id]),
    ]);
  } catch (err) {
    console.warn('Feature/hours/notes fetch failed:', err);
  }

  // Nearby listings via SQL (replaces RPC find_nearby_listings)
  let nearbyListings: NearbyListingRecord[] = [];
  if (listingData.latitude && listingData.longitude) {
    try {
      // Haversine formula for distance calculation in D1
      const nearby = await runQuery(db, `
        SELECT b.id AS listing_id, b.slug, b.name, sub.name AS suburb,
          sub.slug AS suburb_slug, r.slug AS region_slug, b.state_code, s.name AS state,
          CAST(
            6371000 * acos(
              cos(radians(?)) * cos(radians(b.latitude)) * cos(radians(b.longitude) - radians(?)) +
              sin(radians(?)) * sin(radians(b.latitude))
            ) AS INTEGER
          ) AS distance_m
        ${LISTINGS_JOIN}
        WHERE b.id != ?
          AND b.latitude IS NOT NULL
          AND b.longitude IS NOT NULL
        ORDER BY distance_m ASC
        LIMIT 5
      `, [listingData.latitude, listingData.longitude, listingData.latitude, listingData.listing_id]);

      nearbyListings = (nearby || []) as NearbyListingRecord[];
    } catch (err) {
      console.warn('Nearby listings fetch failed:', err);
    }
  }

  return {
    listing: listingData as ListingRecord,
    state: stateResult as StateRecord | null,
    region: regionResult as RegionRecord | null,
    suburb: suburbResult as SuburbRecord | null,
    features,
    hours,
    notes,
    nearbyListings,
    stateSlug: state.toLowerCase(),
    stateCode,
  };
}

/**
 * Fetches data for state listing pages
 */
export async function fetchStateData(state: string, env?: { DB?: D1Database }) {
  const stateCode = state.toUpperCase();
  const db = await getD1Client(env);

  const stateData = await runQuerySingle(db,
    'SELECT code, name, slug, business_count AS listing_count FROM states WHERE code = ? LIMIT 1',
    [stateCode]
  );

  const regions = await runQuery(db,
    'SELECT id, name, slug, state_code, business_count AS listing_count, name AS name_clean FROM regions WHERE state_code = ? ORDER BY name',
    [stateCode]
  );

  return {
    state: stateData as StateRecord | null,
    regions: (regions || []) as RegionRecord[],
    stateSlug: state.toLowerCase(),
  };
}

/**
 * Fetches data for region listing pages
 */
export async function fetchRegionData(state: string, region: string, env?: { DB?: D1Database }) {
  const stateCode = state.toUpperCase();
  const db = await getD1Client(env);

  const [stateResult, regionResult] = await Promise.all([
    runQuerySingle(db, 'SELECT code, name, slug, business_count AS listing_count FROM states WHERE code = ? LIMIT 1', [stateCode]),
    runQuerySingle(db, 'SELECT id, name, slug, state_code, business_count AS listing_count, name AS name_clean FROM regions WHERE slug = ? AND state_code = ? LIMIT 1', [region, stateCode]),
  ]);

  // suburbs join through regions to filter by region_slug
  const suburbs = await runQuery(db,
    'SELECT s.id, s.name, s.slug, s.state_code, s.business_count AS listing_count, NULL AS latitude, NULL AS longitude, r.slug AS region_slug FROM suburbs s JOIN regions r ON s.region_id = r.id WHERE s.state_code = ? AND r.slug = ? ORDER BY s.name',
    [stateCode, region]
  );

  return {
    state: stateResult as StateRecord | null,
    region: regionResult as RegionRecord | null,
    suburbs: (suburbs || []) as SuburbRecord[],
    stateSlug: state.toLowerCase(),
  };
}

/**
 * Fetches data for suburb listing pages
 */
export async function fetchSuburbData(state: string, region: string, suburb: string, env?: { DB?: D1Database }) {
  const stateCode = state.toUpperCase();
  const db = await getD1Client(env);

  const [stateResult, regionResult, suburbResult] = await Promise.all([
    runQuerySingle(db, 'SELECT code, name, slug, business_count AS listing_count FROM states WHERE code = ? LIMIT 1', [stateCode]),
    runQuerySingle(db, 'SELECT id, name, slug, state_code, business_count AS listing_count, name AS name_clean FROM regions WHERE slug = ? AND state_code = ? LIMIT 1', [region, stateCode]),
    runQuerySingle(db, 'SELECT s.id, s.name, s.slug, s.state_code, s.business_count AS listing_count FROM suburbs s WHERE s.slug = ? AND s.state_code = ? LIMIT 1', [suburb, stateCode]),
  ]);

  // Listings for this suburb (state_code + region_slug + suburb_slug)
  const listings = await runQuery(db,
    `SELECT ${LISTINGS_COLS} ${LISTINGS_JOIN} WHERE b.state_code = ? AND r.slug = ? AND sub.slug = ? ORDER BY b.name`,
    [stateCode, region, suburb]
  );

  return {
    state: stateResult as StateRecord | null,
    region: regionResult as RegionRecord | null,
    suburb: suburbResult as SuburbRecord | null,
    listings: (listings || []) as ListingRecord[],
    stateSlug: state.toLowerCase(),
  };
}

/**
 * Fetches EEAT content blocks for a state/region/suburb
 * entity_id mapping: states → code (e.g. 'QLD'); regions → CAST(id AS TEXT); suburbs → CAST(id AS TEXT)
 */
export async function fetchContent(entityType: string, entityId: string, env?: { DB?: D1Database }): Promise<ContentRow[]> {
  const db = await getD1Client(env);
  const rows = await runQuery(db,
    'SELECT content_type, body FROM content WHERE entity_type = ? AND entity_id = ? AND approved = 1',
    [entityType, entityId]
  );
  return (rows || []) as ContentRow[];
}

/**
 * Fetches feature counts for a state (for EEAT placeholder resolution)
 */
export async function fetchStateFeatureCounts(stateCode: string, env?: { DB?: D1Database }): Promise<FeatureCounts> {
  const db = await getD1Client(env);
  const sc = stateCode.toUpperCase();
  const featureKeys = ['accessible', 'baby_change', 'baby_care_room', 'changing_places', 'dump_point', 'shower', 'parking', 'drinking_water'];

  const results = await Promise.all([
    ...featureKeys.map((key) =>
      runCount(db, 'SELECT COUNT(*) as cnt FROM business_features bf JOIN businesses b ON bf.business_id = b.id WHERE b.state_code = ? AND bf.feature_key = ?', [sc, key])
        .then((count) => ({ key, count }))
    ),
    runCount(db, 'SELECT COUNT(*) as cnt FROM businesses WHERE state_code = ? AND is_24_hours = 1', [sc])
      .then((count) => ({ key: 'open_24h', count })),
  ]);

  const map: Record<string, number> = {};
  for (const r of results) map[r.key] = r.count;

  return {
    accessible: map['accessible'] ?? 0,
    open_24h: map['open_24h'] ?? 0,
    baby_change: map['baby_change'] ?? 0,
    baby_care_room: map['baby_care_room'] ?? 0,
    changing_places: map['changing_places'] ?? 0,
    dump_point: map['dump_point'] ?? 0,
    shower: map['shower'] ?? 0,
    parking: map['parking'] ?? 0,
    drinking_water: map['drinking_water'] ?? 0,
  };
}

/**
 * Fetches feature counts for a region (for EEAT placeholder resolution)
 */
export async function fetchRegionFeatureCounts(regionSlug: string, stateCode: string, env?: { DB?: D1Database }): Promise<FeatureCounts> {
  const db = await getD1Client(env);
  const sc = stateCode.toUpperCase();
  const featureKeys = ['accessible', 'baby_change', 'baby_care_room', 'changing_places', 'dump_point', 'shower', 'parking', 'drinking_water'];

  const results = await Promise.all([
    ...featureKeys.map((key) =>
      runCount(db, 'SELECT COUNT(*) as cnt FROM business_features bf JOIN businesses b ON bf.business_id = b.id LEFT JOIN regions r ON b.region_id = r.id WHERE b.state_code = ? AND r.slug = ? AND bf.feature_key = ?', [sc, regionSlug, key])
        .then((count) => ({ key, count }))
    ),
    runCount(db, `SELECT COUNT(*) as cnt FROM businesses b LEFT JOIN regions r ON b.region_id = r.id WHERE b.state_code = ? AND r.slug = ? AND b.is_24_hours = 1`, [sc, regionSlug])
      .then((count) => ({ key: 'open_24h', count }))
  ]);

  const map: Record<string, number> = {};
  for (const r of results) map[r.key] = r.count;

  return {
    accessible: map['accessible'] ?? 0,
    open_24h: map['open_24h'] ?? 0,
    baby_change: map['baby_change'] ?? 0,
    baby_care_room: map['baby_care_room'] ?? 0,
    changing_places: map['changing_places'] ?? 0,
    dump_point: map['dump_point'] ?? 0,
    shower: map['shower'] ?? 0,
    parking: map['parking'] ?? 0,
    drinking_water: map['drinking_water'] ?? 0,
  };
}

/**
 * Fetches listings for a region (for map markers on region pages)
 */
export async function fetchRegionListings(stateCode: string, regionSlug: string, env?: { DB?: D1Database }): Promise<ListingRecord[]> {
  const db = await getD1Client(env);
  const sc = stateCode.toUpperCase();
  const cols = 'b.id AS listing_id, b.slug, b.name, b.address, b.latitude, b.longitude, b.is_24_hours AS is_open_24h, r.slug AS region_slug, sub.slug AS suburb_slug, b.state_code';
  const listings = await runQuery(db,
    `SELECT ${cols} ${LISTINGS_JOIN} WHERE b.state_code = ? AND r.slug = ? ORDER BY b.name`,
    [sc, regionSlug]
  );
  return (listings || []) as ListingRecord[];
}

/**
 * Fetches listings for a state (for map markers on state pages - limited for performance)
 */
export async function fetchStateListings(stateCode: string, limit: number = 100, env?: { DB?: D1Database }): Promise<ListingRecord[]> {
  const db = await getD1Client(env);
  const sc = stateCode.toUpperCase();
  const cols = 'b.id AS listing_id, b.slug, b.name, b.address, b.latitude, b.longitude, b.is_24_hours AS is_open_24h, r.slug AS region_slug, sub.slug AS suburb_slug, b.state_code';
  const listings = await runQuery(db,
    `SELECT ${cols} ${LISTINGS_JOIN} WHERE b.state_code = ? ORDER BY b.name LIMIT ?`,
    [sc, limit]
  );
  return (listings || []) as ListingRecord[];
}

/**
 * Fetches listings for a state filtered by feature key
 * Used for state-level feature-filter pages
 */
export async function fetchStateListingsByFeature(stateCode: string, featureKey: string, env?: { DB?: D1Database }): Promise<ListingRecord[]> {
  const db = await getD1Client(env);
  const sc = stateCode.toUpperCase();

  const listings = await runQuery(db, `
    SELECT DISTINCT b.id AS listing_id, b.slug, b.name, b.address, sub.name AS town, b.latitude, b.longitude, b.is_24_hours AS is_open_24h, r.slug AS region_slug, sub.slug AS suburb_slug, b.state_code
    FROM businesses b
    INNER JOIN business_features bf ON bf.business_id = b.id
    LEFT JOIN suburbs sub ON b.suburb_id = sub.id
    LEFT JOIN regions r ON b.region_id = r.id
    WHERE b.state_code = ? AND bf.feature_key = ?
    ORDER BY b.name
  `, [sc, featureKey.toLowerCase()]);

  return (listings || []) as ListingRecord[];
}

/**
 * Fetches listings for a region filtered by feature key
 * Used for region-level feature-filter pages
 */
export async function fetchRegionListingsByFeature(stateCode: string, regionSlug: string, featureKey: string, env?: { DB?: D1Database }): Promise<ListingRecord[]> {
  const db = await getD1Client(env);
  const sc = stateCode.toUpperCase();

  const listings = await runQuery(db, `
    SELECT DISTINCT b.id AS listing_id, b.slug, b.name, b.address, sub.name AS town, b.latitude, b.longitude, b.is_24_hours AS is_open_24h, r.slug AS region_slug, sub.slug AS suburb_slug, b.state_code
    FROM businesses b
    INNER JOIN business_features bf ON bf.business_id = b.id
    LEFT JOIN suburbs sub ON b.suburb_id = sub.id
    LEFT JOIN regions r ON b.region_id = r.id
    WHERE b.state_code = ? AND r.slug = ? AND bf.feature_key = ?
    ORDER BY b.name
  `, [sc, regionSlug, featureKey.toLowerCase()]);

  return (listings || []) as ListingRecord[];
}

/**
 * Fetches listings for a suburb filtered by feature key
 * Used for suburb-level feature-filter pages
 */
export async function fetchSuburbListingsByFeature(stateCode: string, regionSlug: string, suburbSlug: string, featureKey: string, env?: { DB?: D1Database }): Promise<ListingRecord[]> {
  const db = await getD1Client(env);
  const sc = stateCode.toUpperCase();

  const listings = await runQuery(db, `
    SELECT DISTINCT b.id AS listing_id, b.slug, b.name, b.address, sub.name AS town, b.latitude, b.longitude, b.is_24_hours AS is_open_24h, r.slug AS region_slug, sub.slug AS suburb_slug, b.state_code
    FROM businesses b
    INNER JOIN business_features bf ON bf.business_id = b.id
    LEFT JOIN suburbs sub ON b.suburb_id = sub.id
    LEFT JOIN regions r ON b.region_id = r.id
    WHERE b.state_code = ? AND r.slug = ? AND sub.slug = ? AND bf.feature_key = ?
    ORDER BY b.name
  `, [sc, regionSlug, suburbSlug, featureKey.toLowerCase()]);

  return (listings || []) as ListingRecord[];
}

/**
 * Fetches feature counts for a suburb (for EEAT placeholder resolution)
 * Also used to determine which feature-filter URLs to include in sitemap
 */
export async function fetchSuburbFeatureCounts(stateCode: string, regionSlug: string, suburbSlug: string, env?: { DB?: D1Database }): Promise<FeatureCounts> {
  const db = await getD1Client(env);
  const sc = stateCode.toUpperCase();
  const featureKeys = ['accessible', 'baby_change', 'baby_care_room', 'changing_places', 'dump_point', 'shower', 'parking', 'drinking_water'];

  const results = await Promise.all([
    ...featureKeys.map((key) =>
      runCount(db, `SELECT COUNT(*) as cnt FROM business_features bf JOIN businesses b ON bf.business_id = b.id LEFT JOIN suburbs sub ON b.suburb_id = sub.id LEFT JOIN regions r ON b.region_id = r.id WHERE b.state_code = ? AND r.slug = ? AND sub.slug = ? AND bf.feature_key = ?`, [sc, regionSlug, suburbSlug, key])
        .then((count) => ({ key, count }))
    ),
    runCount(db, `SELECT COUNT(*) as cnt FROM businesses b LEFT JOIN suburbs sub ON b.suburb_id = sub.id LEFT JOIN regions r ON b.region_id = r.id WHERE b.state_code = ? AND r.slug = ? AND sub.slug = ? AND b.is_24_hours = 1`, [sc, regionSlug, suburbSlug])
      .then((count) => ({ key: 'open_24h', count }))
  ]);

  const map: Record<string, number> = {};
  for (const r of results) map[r.key] = r.count;

  return {
    accessible: map['accessible'] ?? 0,
    open_24h: map['open_24h'] ?? 0,
    baby_change: map['baby_change'] ?? 0,
    baby_care_room: map['baby_care_room'] ?? 0,
    changing_places: map['changing_places'] ?? 0,
    dump_point: map['dump_point'] ?? 0,
    shower: map['shower'] ?? 0,
    parking: map['parking'] ?? 0,
    drinking_water: map['drinking_water'] ?? 0,
  };
}

/**
 * Legacy alias — returns the D1 database binding.
 * Kept for backward compatibility with callers that used getDBClient()
 * during the Supabase era. All new code should prefer getD1Client() from ./d1.
 */
export async function getDBClient(env?: { DB?: D1Database }): Promise<D1Database> {
  return getD1Client(env);
}