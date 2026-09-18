/**
 * Search API endpoint for listings, suburbs, and regions
 * Returns matching suburbs and listings for autocomplete
 */
import type { APIRoute } from 'astro';
import { getD1Client, runQuery } from '../../lib/d1';

// State slug map
const STATE_SLUG_MAP: Record<string, string> = {
  NSW: 'nsw',
  VIC: 'vic',
  QLD: 'qld',
  WA:  'wa',
  SA:  'sa',
  TAS: 'tas',
  ACT: 'act',
  NT:  'nt',
};

interface SearchResult {
  type: 'suburb' | 'facility' | 'region';
  id: number | string;
  label: string;
  sublabel: string;
  href: string;
  latitude?: number;
  longitude?: number;
}

/**
 * API Route: GET /api/search?q=term
 * Returns matching suburbs and listings for autocomplete
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const db = await getD1Client({ DB: (locals as any)?.DB });
  const q = url.searchParams.get('q')?.trim() || '';

  if (!q || q.length < 2) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const results: SearchResult[] = [];
    const likePattern = `%${q}%`;

    // Search suburbs (limit 8)
    const suburbs = await runQuery(db,
      `SELECT s.id, s.name, s.slug, s.state_code, r.slug AS region_slug,
         NULL AS latitude, NULL AS longitude
       FROM suburbs s
       LEFT JOIN regions r ON s.region_id = r.id
       WHERE s.name LIKE ?
       ORDER BY s.name
       LIMIT 8`,
      [likePattern]
    );

    for (const s of suburbs) {
      const stateSlug = STATE_SLUG_MAP[s.state_code] ?? s.state_code?.toLowerCase() ?? 'nsw';
      const regionSlug = s.region_slug || '';
      results.push({
        type: 'suburb',
        id: s.id,
        label: `${s.name}, ${s.state_code}`,
        sublabel: 'Suburb',
        href: regionSlug ? `/${stateSlug}/${regionSlug}/${s.slug}` : `/${stateSlug}`,
        latitude: s.latitude,
        longitude: s.longitude,
      });
    }

    // Search listings (limit 8)
    const listings = await runQuery(db,
      `SELECT b.id AS listing_id, b.slug, b.name, b.address, sub.name AS town, b.state_code, r.slug AS region_slug, sub.slug AS suburb_slug
       FROM businesses b
       LEFT JOIN suburbs sub ON b.suburb_id = sub.id
       LEFT JOIN regions r ON b.region_id = r.id
       WHERE b.name LIKE ?
       ORDER BY b.name
       LIMIT 8`,
      [likePattern]
    );

    for (const t of listings) {
      const stateSlug = STATE_SLUG_MAP[t.state_code ?? ''] ?? (t.state_code ?? 'nsw').toLowerCase();
      const sublabel = [t.address, t.town].filter(Boolean).join(', ') || 'Public facility';
      results.push({
        type: 'facility',
        id: t.listing_id,
        label: t.name,
        sublabel,
        href: t.state_code && t.region_slug && t.suburb_slug
          ? `/${stateSlug}/${t.region_slug}/${t.suburb_slug}/${t.slug}`
          : '#',
      });
    }

    return new Response(JSON.stringify(results.slice(0, 16)), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=120',
      },
    });
  } catch (err: any) {
    console.error('[/api/search] Error:', err.message || err);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const OPTIONS: APIRoute = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
};
