const axios = require('axios');
const { geocode, distanceMiles } = require('./geocoder');

const LOADBOARD_URL = process.env.LOADBOARD_URL || 'https://tezway.net/';
const API_URL = LOADBOARD_URL.replace(/\/$/, '') + '/api/loads';

async function scrapeLoads() {
  try {
    console.log(`[Scraper] Fetching ${API_URL}`);
    const res = await axios.get(API_URL, {
      timeout: 15000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; LoadBoardBot/1.0)' },
    });
    const raw = res.data;
    if (!Array.isArray(raw)) {
      console.warn('[Scraper] API returned non-array:', typeof raw);
      return [];
    }
    const loads = raw.map(normalizeLoad);
    console.log(`[Scraper] ${loads.length} loads: ${loads.map(l => `${l.pickupLocation}(${l.loadType})`).join(', ')}`);
    return loads;
  } catch (err) {
    console.error('[Scraper] Error:', err.message);
    return [];
  }
}

function normalizeLoad(raw) {
  // Normalize load type: extract TEAM/SOLO from type field
  const rawType = (raw.type || '').toUpperCase();
  const loadType = rawType.includes('TEAM') ? 'TEAM' : rawType.includes('SOLO') ? 'SOLO' : rawType;

  // Determine source category: "usps" for USPS mail loads, "broker" for telegram broker loads
  const rawSource = (raw.source || '').toLowerCase();
  let sourceCategory = 'broker'; // default
  if (rawSource.startsWith('telegram:')) {
    sourceCategory = 'broker';
  } else if (rawSource === 'usps' || rawSource === '') {
    sourceCategory = 'usps';
  }

  return {
    id:              String(raw.id || raw.loadNumber || Math.random()),
    loadNumber:      String(raw.loadNumber || ''),
    source:          raw.source || 'broker',           // raw source string from API
    sourceCategory,                                     // 'usps' or 'broker'
    pickupLocation:  `${raw.originCity || ''}, ${raw.originState || ''}`.replace(/^,\s*/, '').replace(/,\s*$/, '').trim(),
    pickupCity:      (raw.originCity || '').trim(),
    pickupState:     (raw.originState || '').toUpperCase().trim(),
    dropoffLocation: `${raw.destCity || ''}, ${raw.destState || ''}`.replace(/^,\s*/, '').replace(/,\s*$/, '').trim(),
    dropoffState:    (raw.destState || '').toUpperCase().trim(),
    pickupTime:      raw.pickupTime || '',
    pickupTimezone:  raw.pickupTimezone || 'ET',        // timezone label from API
    loadType,                          // 'TEAM', 'SOLO', or raw value
    miles:           raw.miles  ? String(raw.miles)  : '',
    rate:            raw.rate   ? String(raw.rate)   : '',
    status:          raw.status || '',
    raw,
  };
}

/**
 * Match a load against a preference using pre-geocoded trucks.
 * geocodedTrucks: [{label, location, lat, lon}] — already resolved, no async needed
 * Returns { matched: false } | { matched: true, truck, distanceMiles, loadGeo }
 */
async function matchesPreferences(load, pref, geocodedTrucks) {
  // ── Load type filter (TEAM / SOLO / any) ─────────────────────────────────
  if (pref.load_type_filter) {
    if (load.loadType !== pref.load_type_filter) return { matched: false };
  }

  // ── Date range filter ─────────────────────────────────────────────────────
  if (pref.pickup_date && load.pickupTime) {
    const loadDate = load.pickupTime.substring(0, 10);
    if (pref.pickup_date_end) {
      if (loadDate < pref.pickup_date || loadDate > pref.pickup_date_end) return { matched: false };
    } else {
      if (loadDate < pref.pickup_date) return { matched: false };
    }
  }

  // ── Radius filter ─────────────────────────────────────────────────────────
  if (!geocodedTrucks || geocodedTrucks.length === 0) return { matched: false };

  // Geocode load pickup — almost always in memory cache by now
  const loadGeo = await geocode(load.pickupLocation);
  if (!loadGeo) {
    console.warn(`[Scraper] Could not geocode load location: "${load.pickupLocation}"`);
    return { matched: false };
  }

  const radiusMiles = pref.radius_miles || 100;
  let bestTruck = null, bestDist = Infinity;

  for (const truck of geocodedTrucks) {
    const dist = distanceMiles(truck.lat, truck.lon, loadGeo.lat, loadGeo.lon);
    if (dist < bestDist) { bestDist = dist; bestTruck = truck; }
  }

  if (bestTruck && bestDist <= radiusMiles) {
    return { matched: true, truck: bestTruck, distanceMiles: Math.round(bestDist), loadGeo };
  }
  return { matched: false };
}

module.exports = { scrapeLoads, matchesPreferences };
