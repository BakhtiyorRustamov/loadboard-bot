/**
 * fedex-scraper.js
 * Logs into https://carrier-fedex.zuumapp.com with stored credentials,
 * intercepts the internal API calls the SPA makes, stores the auth token,
 * then uses direct axios calls for every subsequent poll (no browser needed).
 *
 * Required env vars:
 *   FEDEX_USERNAME   — your zuumapp login email/username
 *   FEDEX_PASSWORD   — your zuumapp password
 */

const puppeteer = require('puppeteer');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const FEDEX_URL = 'https://carrier-fedex.zuumapp.com';
const LOGIN_URL = `${FEDEX_URL}/main/shipments`;

// ─── Token storage in SQLite ───────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data', 'loadboard.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS fedex_session (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    token       TEXT,
    api_base    TEXT,
    discovered_url TEXT,
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe migration for new column
try { db.exec(`ALTER TABLE fedex_session ADD COLUMN discovered_url TEXT`); } catch (_) {}

function saveSession(token, apiBase, discoveredUrl) {
  db.prepare(`
    INSERT INTO fedex_session (id, token, api_base, discovered_url, captured_at) VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token, api_base=excluded.api_base, discovered_url=excluded.discovered_url, captured_at=excluded.captured_at
  `).run(token, apiBase, discoveredUrl || null);
}

function loadSession() {
  return db.prepare('SELECT * FROM fedex_session WHERE id=1').get() || null;
}

// Token refresh interval: 8 hours (zuumapp tokens typically last 24h)
const TOKEN_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function isSessionFresh(session) {
  if (!session || !session.token) return false;
  const age = Date.now() - new Date(session.captured_at).getTime();
  return age < TOKEN_MAX_AGE_MS;
}

// ─── Puppeteer login + API interception ───────────────────────────────────────
let browserInstance = null;

async function launchBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  console.log('[FedEx] Launching headless browser for login...');
  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run', '--single-process',
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  return browserInstance;
}

/**
 * Log in via Puppeteer, intercept the auth token and API base URL.
 * Also captures shipments data directly from API responses during login.
 * Returns { token, apiBase, discoveredUrl, shipments } or null on failure.
 */
async function loginAndCaptureToken() {
  const username = process.env.FEDEX_USERNAME;
  const password = process.env.FEDEX_PASSWORD;

  if (!username || !password) {
    console.error('[FedEx] FEDEX_USERNAME and FEDEX_PASSWORD env vars not set — skipping FedEx monitoring');
    return null;
  }

  let page = null;
  let captured = null;
  let capturedShipments = null;

  try {
    const browser = await launchBrowser();
    page = await browser.newPage();

    // Set a real user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Block images/fonts/media to speed up login
    await page.setRequestInterception(true);

    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) { req.abort(); return; }
      req.continue();
    });

    // Intercept ALL JSON responses to find auth tokens and shipment data
    page.on('response', async response => {
      const url = response.url();
      const status = response.status();
      if (status !== 200) return;

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;

      try {
        const authHeader = response.request().headers()['authorization'] ||
                           response.request().headers()['Authorization'];

        if (authHeader && authHeader.startsWith('Bearer ')) {
          const token = authHeader.replace('Bearer ', '').trim();
          const urlObj = new URL(url);
          const apiBase = `${urlObj.protocol}//${urlObj.host}`;
          if (!captured) {
            captured = { token, apiBase, apiUrl: url };
            console.log(`[FedEx] ✓ Captured auth token from: ${url}`);
          }

          // Also try to capture shipments data from any API response with auth
          try {
            const json = await response.json();
            if (json && (Array.isArray(json) || json.data || json.shipments || json.loads || json.content)) {
              const items = Array.isArray(json) ? json :
                            (json.data || json.shipments || json.loads || json.content || []);
              if (Array.isArray(items) && items.length > 0) {
                capturedShipments = json;
                captured.discoveredUrl = url;
                console.log(`[FedEx] ✓ Captured ${items.length} shipments from: ${url}`);
              }
            }
          } catch (_) {}
          return;
        }

        // Also check response body for token patterns (some SPAs return it in login response)
        if (url.includes('auth') || url.includes('login') || url.includes('token') || url.includes('oauth')) {
          const json = await response.json().catch(() => null);
          if (json) {
            const token = findToken(json);
            if (token && !captured) {
              const urlObj = new URL(url);
              const apiBase = `${urlObj.protocol}//${urlObj.host}`;
              captured = { token, apiBase, apiUrl: url };
              console.log(`[FedEx] ✓ Captured token from login response: ${url}`);
            }
          }
        }
      } catch (_) {}
    });

    console.log('[FedEx] Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    // Log the page state for debugging
    const pageUrl = page.url();
    const pageTitle = await page.title();
    console.log(`[FedEx] Page loaded: ${pageUrl} — "${pageTitle}"`);

    // If already redirected past login (session still valid in browser), check if we captured data
    if (captured) {
      saveSession(captured.token, captured.apiBase, captured.discoveredUrl || null);
      console.log(`[FedEx] Session saved. API base: ${captured.apiBase}`);
      return { ...captured, shipments: capturedShipments };
    }

    // Wait for login form
    try {
      await page.waitForSelector('input[type="email"], input[type="text"], input[name="username"], input[name="email"], input[placeholder*="email" i], input[placeholder*="user" i]', { timeout: 15000 });
    } catch (e) {
      console.error(`[FedEx] Could not find login form. Page URL: ${page.url()}`);
      // Take a screenshot for debugging (log base64 summary)
      try {
        const screenshotBuf = await page.screenshot({ encoding: 'base64' });
        console.log(`[FedEx] Screenshot taken (${Math.round(screenshotBuf.length/1024)}KB base64). Page likely has different login form.`);
      } catch (_) {}
      return null;
    }

    // Fill credentials — try multiple selector strategies
    const emailSelectors = [
      'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
      'input[placeholder*="email" i]', 'input[placeholder*="user" i]',
      'input[type="text"]'
    ];
    let emailFilled = false;
    for (const sel of emailSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 }); // select all existing text
        await el.type(username, { delay: 40 });
        emailFilled = true;
        console.log(`[FedEx] Filled email using selector: ${sel}`);
        break;
      }
    }

    if (!emailFilled) {
      console.error('[FedEx] Could not find email input field');
      return null;
    }

    // Fill password
    const passEl = await page.$('input[type="password"]');
    if (passEl) {
      await passEl.click({ clickCount: 3 });
      await passEl.type(password, { delay: 40 });
      console.log('[FedEx] Filled password');
    } else {
      console.error('[FedEx] Could not find password input field');
      return null;
    }

    // Click submit — try multiple strategies
    const submitSelectors = [
      'button[type="submit"]', 'input[type="submit"]',
      'button.login-btn', 'button.btn-primary',
      'button[class*="login" i]', 'button[class*="submit" i]',
    ];
    let clicked = false;
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        clicked = true;
        console.log(`[FedEx] Clicked submit using selector: ${sel}`);
        break;
      }
    }
    if (!clicked) {
      // Fallback: find any button with login/sign-in text
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const text = await page.evaluate(el => el.textContent.toLowerCase(), btn);
        if (text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('submit')) {
          await btn.click();
          clicked = true;
          console.log(`[FedEx] Clicked submit button with text: "${text.trim()}"`);
          break;
        }
      }
    }
    if (!clicked) {
      // Last resort: press Enter
      await page.keyboard.press('Enter');
      console.log('[FedEx] Pressed Enter as fallback submit');
    }

    // Wait for navigation / API calls after login
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000)); // allow API calls to complete

    if (!captured) {
      // Try scrolling/interacting to trigger API calls
      console.log('[FedEx] No token captured yet — trying scroll to trigger API calls...');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 3000));

      // Try clicking on shipments tab/link if visible
      const navLinks = await page.$$('a[href*="shipment"], a[href*="load"], button[class*="shipment" i]');
      for (const link of navLinks) {
        try { await link.click(); await new Promise(r => setTimeout(r, 2000)); } catch (_) {}
        if (captured) break;
      }
    }

    if (captured) {
      saveSession(captured.token, captured.apiBase, captured.discoveredUrl || null);
      console.log(`[FedEx] Session saved. API base: ${captured.apiBase}`);
      return { ...captured, shipments: capturedShipments };
    }

    // Log final state for debugging
    const finalUrl = page.url();
    console.error(`[FedEx] Could not capture auth token. Final page URL: ${finalUrl}`);
    return null;

  } catch (err) {
    console.error('[FedEx] Login error:', err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** Recursively search JSON for token-like fields */
function findToken(obj, depth = 0) {
  if (depth > 5 || !obj) return null;
  if (typeof obj === 'string' && obj.length > 50 && /^[A-Za-z0-9\-_\.]+$/.test(obj)) return obj;
  if (typeof obj !== 'object') return null;
  for (const key of ['token', 'accessToken', 'access_token', 'authToken', 'jwt', 'bearerToken', 'id_token']) {
    if (obj[key] && typeof obj[key] === 'string') return obj[key];
  }
  for (const val of Object.values(obj)) {
    const found = findToken(val, depth + 1);
    if (found) return found;
  }
  return null;
}

// ─── Fetch shipments via direct API ───────────────────────────────────────────
/**
 * Try common API patterns for zuumapp shipments endpoint.
 * Returns raw shipments array or null.
 */
async function fetchShipmentsAPI(token, apiBase, discoveredUrl) {
  // Start with the previously discovered URL (if any), then try common patterns
  const endpoints = [];
  if (discoveredUrl) endpoints.push(discoveredUrl);

  const patterns = [
    '/api/shipments', '/api/v1/shipments', '/api/v2/shipments',
    '/api/loads', '/api/v1/loads', '/api/v2/loads',
    '/api/carrier/shipments', '/api/carrier/loads',
    '/api/carrier/shipments/search', '/api/shipments/search',
    '/main/api/shipments', '/api/available-shipments',
    '/api/carrier/available-loads', '/api/freight/shipments',
  ];

  for (const p of patterns) {
    const url = `${apiBase}${p}`;
    if (!endpoints.includes(url)) endpoints.push(url);
  }

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Origin': FEDEX_URL,
          'Referer': LOGIN_URL,
        },
        timeout: 10000,
      });
      if (Array.isArray(res.data) || (res.data && typeof res.data === 'object')) {
        const items = Array.isArray(res.data) ? res.data :
                      (res.data.data || res.data.shipments || res.data.loads || res.data.content || []);
        if (Array.isArray(items) && items.length > 0) {
          console.log(`[FedEx] ✓ Got ${items.length} items from API: ${url}`);
          // Save this discovered URL for next time
          const session = loadSession();
          if (session && session.discovered_url !== url) {
            saveSession(session.token, session.api_base, url);
          }
          return res.data;
        }
        console.log(`[FedEx] Empty data from: ${url}`);
      }
    } catch (err) {
      if (err.response?.status === 401) {
        console.log('[FedEx] Token expired (401) — will re-login');
        return 'EXPIRED';
      }
      // 404/403 = wrong endpoint, try next
    }
  }
  console.warn(`[FedEx] No data from any of ${endpoints.length} endpoints`);
  return null;
}

// ─── Main public function ──────────────────────────────────────────────────────
/**
 * Fetch FedEx loads. Returns normalized load array (same format as USPS loads).
 */
async function fetchFedexLoads() {
  if (!process.env.FEDEX_USERNAME || !process.env.FEDEX_PASSWORD) return [];

  let session = loadSession();

  // Refresh token if stale
  if (!isSessionFresh(session)) {
    console.log('[FedEx] Session stale or missing — logging in...');
    const captured = await loginAndCaptureToken();
    if (!captured) return [];
    // If we captured shipments during login, use them directly
    if (captured.shipments) {
      console.log('[FedEx] Using shipments captured during login');
      return normalizeFedexLoads(captured.shipments);
    }
    session = loadSession();
  }

  if (!session?.token) return [];

  // Try direct API call
  const raw = await fetchShipmentsAPI(session.token, session.api_base || FEDEX_URL, session.discovered_url);

  if (raw === 'EXPIRED') {
    // Force re-login
    saveSession(null, null, null);
    const captured = await loginAndCaptureToken();
    if (!captured) return [];
    if (captured.shipments) return normalizeFedexLoads(captured.shipments);
    const newSession = loadSession();
    if (!newSession?.token) return [];
    const retried = await fetchShipmentsAPI(newSession.token, newSession.api_base || FEDEX_URL, newSession.discovered_url);
    if (!retried || retried === 'EXPIRED') return [];
    return normalizeFedexLoads(retried);
  }

  if (!raw) {
    console.warn('[FedEx] No data returned from API — attempting fresh login');
    saveSession(null, null, null);
    const captured = await loginAndCaptureToken();
    if (captured?.shipments) return normalizeFedexLoads(captured.shipments);
    return [];
  }

  return normalizeFedexLoads(raw);
}

function normalizeFedexLoads(raw) {
  const items = Array.isArray(raw) ? raw : (raw.data || raw.shipments || raw.loads || raw.content || []);
  if (!Array.isArray(items)) { console.warn('[FedEx] Unexpected API shape:', typeof raw); return []; }

  return items.map(item => {
    const origin = item.origin || item.pickup || item.originCity || item.pickupLocation || {};
    const dest = item.destination || item.delivery || item.destCity || item.deliveryLocation || {};

    const originCity  = typeof origin === 'string' ? origin : (origin.city || origin.name || item.originCity || item.pickupCity || '');
    const originState = typeof origin === 'string' ? '' : (origin.state || origin.stateCode || item.originState || item.pickupState || '');
    const destCity    = typeof dest === 'string' ? dest : (dest.city || dest.name || item.destCity || item.deliveryCity || '');
    const destState   = typeof dest === 'string' ? '' : (dest.state || dest.stateCode || item.destState || item.deliveryState || '');

    const rawType = (item.type || item.loadType || item.driverType || item.equipmentType || '').toUpperCase();
    const loadType = rawType.includes('TEAM') ? 'TEAM' : rawType.includes('SOLO') ? 'SOLO' : rawType;

    return {
      id:              'fedex:' + String(item.id || item.shipmentId || item.loadId || Math.random()),
      loadNumber:      String(item.shipmentNumber || item.loadNumber || item.id || ''),
      source:          'FedEx',
      sourceCategory:  'fedex',
      pickupLocation:  [originCity, originState].filter(Boolean).join(', '),
      pickupCity:      originCity,
      pickupState:     originState.toUpperCase(),
      dropoffLocation: [destCity, destState].filter(Boolean).join(', '),
      dropoffState:    destState.toUpperCase(),
      pickupTime:      item.pickupTime || item.pickup_time || item.scheduledPickup || item.pickupDate || '',
      pickupTimezone:  item.pickupTimezone || 'ET',
      loadType,
      miles:           item.miles || item.distance || '',
      rate:            item.rate || item.pay || '',
      status:          item.status || '',
      raw:             item,
    };
  }).filter(l => l.pickupLocation || l.dropoffLocation); // skip empty entries
}

module.exports = { fetchFedexLoads };
