/**
 * geocoder.js
 * - Nominatim for geocoding (free, no API key)
 * - SQLite cache (only successful results stored)
 * - In-memory cache layer on top for zero-latency repeated lookups within a session
 * - Parallel batch geocoding with rate limiting for startup pre-warming
 */

const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'loadboard.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS geocode_cache (
    query        TEXT PRIMARY KEY,
    lat          REAL NOT NULL,
    lon          REAL NOT NULL,
    display_name TEXT,
    cached_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Purge old null-lat rows from before the previous fix
try {
  const purged = db.prepare('DELETE FROM geocode_cache WHERE lat IS NULL').run();
  if (purged.changes > 0) console.log(`[Geocoder] Purged ${purged.changes} bad null-lat cache rows`);
} catch (_) {}

const sqlGet = db.prepare('SELECT lat, lon, display_name FROM geocode_cache WHERE query = ?');
const sqlSet = db.prepare('INSERT OR REPLACE INTO geocode_cache (query, lat, lon, display_name) VALUES (?, ?, ?, ?)');

// In-memory cache — survives the whole process lifetime, zero-cost lookup
const memCache = new Map();

// Pre-load SQLite cache into memory on startup
try {
  const rows = db.prepare('SELECT query, lat, lon, display_name FROM geocode_cache').all();
  for (const r of rows) memCache.set(r.query, { lat: r.lat, lon: r.lon, displayName: r.display_name });
  console.log(`[Geocoder] Loaded ${rows.length} cached locations into memory`);
} catch (_) {}

// Nominatim rate limiter: 1 req/sec max
const queue = [];
let processing = false;
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (!processing) processQueue();
  });
}
async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const { fn, resolve, reject } = queue.shift();
    try { resolve(await fn()); } catch (e) { reject(e); }
    if (queue.length > 0) await new Promise(r => setTimeout(r, 1100));
  }
  processing = false;
}

async function nominatimLookup(locationStr) {
  return enqueue(async () => {
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: locationStr.trim(), format: 'json', limit: 1, countrycodes: 'us', addressdetails: 0 },
      timeout: 10000,
      headers: { 'User-Agent': 'LoadBoardBot/1.0', 'Accept-Language': 'en' },
    });
    return res.data;
  });
}

/**
 * Geocode a single location string → { lat, lon, displayName } or null
 * Memory cache → SQLite cache → Nominatim API
 */
async function geocode(locationStr) {
  if (!locationStr || !locationStr.trim()) return null;
  const key = locationStr.trim().toLowerCase();

  // Raw coordinates: "41.8781, -87.6298"
  const coord = key.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (coord) {
    const r = { lat: parseFloat(coord[1]), lon: parseFloat(coord[2]), displayName: key };
    memCache.set(key, r);
    return r;
  }

  // Memory cache
  if (memCache.has(key)) return memCache.get(key);

  // Nominatim
  try {
    const data = await nominatimLookup(locationStr);
    if (!data || data.length === 0) {
      console.warn(`[Geocoder] No result for "${locationStr}"`);
      return null;
    }
    const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), displayName: data[0].display_name };
    memCache.set(key, result);
    sqlSet.run(key, result.lat, result.lon, result.displayName);
    console.log(`[Geocoder] ✓ "${locationStr}" → ${result.lat.toFixed(3)}, ${result.lon.toFixed(3)}`);
    return result;
  } catch (err) {
    console.error(`[Geocoder] Error for "${locationStr}":`, err.message);
    return null;
  }
}

/** Haversine distance in miles — returns Infinity on bad input */
function distanceMiles(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 3958.8, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Parse truck list text into [{label, location}]
 * Handles: "City, ST" / "City ST" / "Label: City, ST" / "Label - City, ST" / "lat, lon"
 */
function parseTruckLines(trucksText) {
  if (!trucksText) return [];
  return trucksText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 2 && !l.startsWith('#'))
    .map(line => {
      // Explicit label separator: "T-101: Memphis, TN" or "Truck 5 - Dallas TX"
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9\-_ ]{0,15})\s*[:\-]\s+(.{3,})$/);
      if (m && !/^\d/.test(m[2])) {
        return { label: m[1].trim(), location: m[2].trim() };
      }
      return { label: null, location: line };
    });
}

/**
 * Geocode all trucks in a text block.
 * Returns [{label, location, lat, lon, displayName}]
 * Already-cached entries resolve instantly; only unknown ones hit Nominatim.
 */
async function geocodeTrucks(trucksText) {
  const entries = parseTruckLines(trucksText);
  const results = [];
  for (const entry of entries) {
    const geo = await geocode(entry.location);
    if (geo) {
      results.push({ ...entry, lat: geo.lat, lon: geo.lon, displayName: geo.displayName });
    } else {
      console.warn(`[Geocoder] Could not geocode truck location: "${entry.location}"`);
    }
  }
  return results;
}

/**
 * Pre-warm geocode cache for all truck locations currently in DB.
 * Call this once on server start so first monitor cycle is fast.
 */
async function prewarmTruckCache(getAllActivePreferences) {
  const prefs = getAllActivePreferences();
  const allLines = new Set();
  for (const pref of prefs) {
    if (!pref.trucks_text) continue;
    for (const entry of parseTruckLines(pref.trucks_text)) {
      const key = entry.location.trim().toLowerCase();
      if (!memCache.has(key)) allLines.add(entry.location);
    }
  }
  if (allLines.size === 0) {
    console.log('[Geocoder] Pre-warm: all truck locations already cached');
    return;
  }
  console.log(`[Geocoder] Pre-warming ${allLines.size} uncached truck locations...`);
  for (const loc of allLines) await geocode(loc);
  console.log('[Geocoder] Pre-warm complete ✓');
}

module.exports = { geocode, geocodeTrucks, distanceMiles, parseTruckLines, prewarmTruckCache };
