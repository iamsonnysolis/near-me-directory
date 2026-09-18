import { getD1Client, runQuery } from '../lib/d1';
import { FEATURE_KEYS } from '../lib/types';

// Convert snake_case to kebab-case for URLs
const toKebabCase = (snakeStr: string): string => snakeStr.replace(/_/g, '-');

// Generate sitemap.xml dynamically via D1 SQL queries
export async function GET() {
  const SITE_URL = import.meta.env?.PUBLIC_SITE_URL || 'https://nearme.directory';
  const db = await getD1Client();

  // Get all states
  const states = await runQuery(db, 'SELECT code FROM states ORDER BY code');

  // Get all regions with listings
  const regions = await runQuery(db, 'SELECT slug, state_code, business_count AS listing_count FROM regions WHERE business_count > 0');

  // Get all suburbs with listings (join regions for region_slug)
  const suburbs = await runQuery(db, 'SELECT s.slug, s.state_code, r.slug AS region_slug FROM suburbs s JOIN regions r ON s.region_id = r.id WHERE s.business_count > 0');

  // Get all listings (businesses with joins for region/suburb slugs)
  const listings = await runQuery(db,
    'SELECT b.slug, b.state_code, r.slug AS region_slug, sub.slug AS suburb_slug ' +
    'FROM businesses b ' +
    'LEFT JOIN suburbs sub ON b.suburb_id = sub.id ' +
    'LEFT JOIN regions r ON b.region_id = r.id'
  );

  const urls: string[] = [''];

  // Add state pages
  states.forEach((state: any) => {
    urls.push(`/${state.code.toLowerCase()}`);
  });

  // Add region pages
  regions.forEach((region: any) => {
    urls.push(`/${region.state_code.toLowerCase()}/${region.slug}`);
  });

  // Add suburb pages
  suburbs.forEach((suburb: any) => {
    urls.push(`/${suburb.state_code.toLowerCase()}/${suburb.region_slug}/${suburb.slug}`);
  });

  // Add listing pages
  listings.forEach((facility: any) => {
    urls.push(`/${facility.state_code.toLowerCase()}/${facility.region_slug}/${facility.suburb_slug}/${facility.slug}`);
  });

  // === FEATURE-FILTER PAGES ===
  // Query business_features joined with businesses, regions, and suburbs
  // to get state_code, region_slug, and suburb_slug
  const allFeatures = await runQuery(db,
    'SELECT bf.feature_key, b.state_code, r.slug AS region_slug, sub.slug AS suburb_slug ' +
    'FROM business_features bf ' +
    'JOIN businesses b ON bf.business_id = b.id ' +
    'LEFT JOIN suburbs sub ON b.suburb_id = sub.id ' +
    'LEFT JOIN regions r ON b.region_id = r.id'
  );

  const stateFeatures: Record<string, Set<string>> = {};
  const regionFeatures: Record<string, Set<string>> = {};
  const suburbFeatures: Record<string, Set<string>> = {};

  allFeatures.forEach((row: any) => {
    const featureKey = row.feature_key;
    if (!FEATURE_KEYS.includes(featureKey)) return;

    const kebabKey = toKebabCase(featureKey);

    const stateCode = row.state_code?.toUpperCase();
    if (stateCode) {
      if (!stateFeatures[stateCode]) stateFeatures[stateCode] = new Set();
      stateFeatures[stateCode].add(kebabKey);
    }

    if (stateCode && row.region_slug) {
      const regionKey = `${stateCode}/${row.region_slug}`;
      if (!regionFeatures[regionKey]) regionFeatures[regionKey] = new Set();
      regionFeatures[regionKey].add(kebabKey);
    }

    if (stateCode && row.region_slug && row.suburb_slug) {
      const suburbKey = `${stateCode}/${row.region_slug}/${row.suburb_slug}`;
      if (!suburbFeatures[suburbKey]) suburbFeatures[suburbKey] = new Set();
      suburbFeatures[suburbKey].add(kebabKey);
    }
  });

  // State-level feature pages (using /with/)
  for (const state of states) {
    const stateCode = state.code?.toUpperCase();
    if (stateCode && stateFeatures[stateCode]) {
      stateFeatures[stateCode].forEach(featureKey => {
        urls.push(`/${stateCode.toLowerCase()}/with/${featureKey}`);
      });
    }
  }

  // Region-level feature pages (using /with/)
  for (const region of regions) {
    const stateCode = region.state_code?.toUpperCase();
    const regionSlug = region.slug;
    const regionKey = `${stateCode}/${regionSlug}`;
    if (regionKey && regionFeatures[regionKey]) {
      regionFeatures[regionKey].forEach(featureKey => {
        urls.push(`/${stateCode?.toLowerCase()}/${regionSlug}/with/${featureKey}`);
      });
    }
  }

  // Suburb-level feature pages (using /with/)
  for (const suburb of suburbs) {
    const stateCode = suburb.state_code?.toUpperCase();
    const regionSlug = suburb.region_slug;
    const suburbSlug = suburb.slug;
    const suburbKey = `${stateCode}/${regionSlug}/${suburbSlug}`;
    if (suburbKey && suburbFeatures[suburbKey]) {
      suburbFeatures[suburbKey].forEach(featureKey => {
        urls.push(`/${stateCode?.toLowerCase()}/${regionSlug}/${suburbSlug}/with/${featureKey}`);
      });
    }
  }

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url><loc>${SITE_URL}${url}</loc><changefreq>weekly</changefreq></url>`).join('\n')}
</urlset>`;

  return new Response(sitemap, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
}