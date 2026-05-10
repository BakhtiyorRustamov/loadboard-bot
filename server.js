require('dotenv').config();

const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const path = require('path');

const db = require('./database');
const { scrapeLoads, matchesPreferences } = require('./scraper');
const { fetchFedexLoads } = require('./fedex-scraper');
const { geocodeTrucks, prewarmTruckCache } = require('./geocoder');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_SECONDS || '60');

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN required'); process.exit(1); }

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🤖 Bot started');

// ─── Bot Commands ──────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const { id, username, first_name, last_name } = msg.from;
  db.upsertUser(id, username, first_name, last_name);
  await bot.sendMessage(id,
    `👋 Welcome${first_name ? `, ${first_name}` : ''}!\n\nI monitor the USPS Load Board and notify you when loads are within range of your trucks.\n\nTap the button below:`,
    { reply_markup: { inline_keyboard: [[{ text: '⚙️ Set Preferences', web_app: { url: `${APP_URL}?user_id=${id}` } }]] } }
  );
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.from.id,
    `📋 *Commands:*\n\n/start — Open the Mini App\n/status — View active alerts\n/stop — Pause all alerts\n/resume — Resume alerts\n/help — This message\n\n_Checks the load board every ${CHECK_INTERVAL} seconds._`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, async (msg) => {
  const prefs = db.getUserPreferences(msg.from.id);
  if (!prefs.length) return bot.sendMessage(msg.from.id, '📭 No alerts.\n\nUse /start to configure.');
  let text = `📊 *Your Alerts (${prefs.length}):*\n\n`;
  for (const p of prefs) {
    const truckCount = p.trucks_text ? p.trucks_text.split('\n').filter(l => l.trim()).length : 0;
    const typeLabel = p.load_type_filter ? ` · ${p.load_type_filter} only` : '';
    text += `${p.is_active ? '🟢' : '🔴'} *${p.name}*\n`;
    text += `  🚛 ${truckCount} trucks · 📏 ${p.radius_miles || 100}mi${typeLabel}\n`;
    if (p.pickup_date) text += `  📅 ${p.pickup_date}${p.pickup_date_end ? ` → ${p.pickup_date_end}` : '+'}\n`;
    text += '\n';
  }
  await bot.sendMessage(msg.from.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/stop/, async (msg) => {
  require('better-sqlite3')(path.join(__dirname,'data','loadboard.db'))
    .prepare('UPDATE users SET is_active=0 WHERE telegram_id=?').run(msg.from.id);
  await bot.sendMessage(msg.from.id, '🔕 Paused. Send /resume to re-enable.');
});

bot.onText(/\/resume/, async (msg) => {
  require('better-sqlite3')(path.join(__dirname,'data','loadboard.db'))
    .prepare('UPDATE users SET is_active=1 WHERE telegram_id=?').run(msg.from.id);
  await bot.sendMessage(msg.from.id, '🔔 Alerts re-enabled!');
});

bot.on('web_app_data', async (msg) => {
  try {
    const data = JSON.parse(msg.web_app_data.data);
    const tid = msg.from.id;
    db.upsertUser(tid, msg.from.username, msg.from.first_name, msg.from.last_name);
    db.savePreference(tid, data);
    const tc = data.trucksText ? data.trucksText.split('\n').filter(l=>l.trim()).length : 0;
    const typeLabel = data.loadTypeFilter ? ` · ${data.loadTypeFilter} only` : '';
    await bot.sendMessage(tid,
      `✅ *Alert Saved!*\n\n*${data.name||'My Alert'}*\n🚛 ${tc} trucks · 📏 ${data.radiusMiles||100}mi${typeLabel}\n\nI'll notify you when matching loads appear!`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) { console.error('[Bot] web_app_data error:', e); }
});

// ─── API Routes ────────────────────────────────────────────────────────────────
app.get('/api/preferences/:tid', (req, res) => {
  try { res.json({ success: true, preferences: db.getUserPreferences(parseInt(req.params.tid)) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/preferences', (req, res) => {
  try {
    const { telegramId, preference, username, firstName, lastName } = req.body;
    if (!telegramId) return res.status(400).json({ success: false, error: 'telegramId required' });
    db.upsertUser(telegramId, username, firstName, lastName);
    const result = db.savePreference(telegramId, preference);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/preferences/:tid/:pid', (req, res) => {
  try { db.deletePreference(parseInt(req.params.tid), parseInt(req.params.pid)); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/preferences/:tid/:pid/toggle', (req, res) => {
  try {
    const result = db.togglePreference(parseInt(req.params.tid), parseInt(req.params.pid));
    if (!result) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', lastScrape: global.lastScrapeInfo || null, uptime: process.uptime() });
});

// ─── Monitor Loop ──────────────────────────────────────────────────────────────
// Cache geocoded trucks per-preference in memory — rebuilt only when pref changes
const truckGeoCache = new Map(); // key: pref.id, value: { hash, trucks[] }

function hashText(s) { let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h; }

async function getGeocodedTrucksForPref(pref) {
  if (!pref.trucks_text || !pref.trucks_text.trim()) return [];
  const hash = hashText(pref.trucks_text + (pref.radius_miles||100));
  const cached = truckGeoCache.get(pref.id);
  if (cached && cached.hash === hash) return cached.trucks;

  const trucks = await geocodeTrucks(pref.trucks_text);
  truckGeoCache.set(pref.id, { hash, trucks });
  console.log(`[Monitor] Pref #${pref.id} "${pref.name}": ${trucks.length}/${pref.trucks_text.split('\n').filter(l=>l.trim()).length} trucks geocoded`);
  return trucks;
}

async function runMonitor() {
  const start = Date.now();
  console.log(`[Monitor] ─── Cycle start ${new Date().toISOString()}`);
  try {
    // Fetch from all active sources in parallel
    const [uspsLoads, fedexLoads] = await Promise.all([
      scrapeLoads(),
      fetchFedexLoads(),
    ]);
    const loads = [...uspsLoads, ...fedexLoads];
    global.lastScrapeInfo = {
      timestamp: new Date().toISOString(),
      uspsLoads: uspsLoads.length,
      fedexLoads: fedexLoads.length,
      totalLoads: loads.length,
    };
    console.log(`[Monitor] Sources: USPS=${uspsLoads.length} FedEx=${fedexLoads.length} Total=${loads.length}`);
    if (loads.length === 0) { console.log('[Monitor] No loads from any source'); return; }

    const allPrefs = db.getAllActivePreferences();
    if (allPrefs.length === 0) { console.log('[Monitor] No active preferences'); return; }

    // Group prefs by user
    const byUser = {};
    for (const pref of allPrefs) {
      if (!byUser[pref.telegram_id]) byUser[pref.telegram_id] = [];
      byUser[pref.telegram_id].push(pref);
    }

    let notifCount = 0;
    for (const [telegramId, prefs] of Object.entries(byUser)) {
      for (const pref of prefs) {
        // Get trucks (from in-memory pref cache — instant if unchanged)
        const geocodedTrucks = await getGeocodedTrucksForPref(pref);
        if (geocodedTrucks.length === 0) continue;

        // Parse source filter for this preference
        let sourceFilter = null;
        try { sourceFilter = pref.source_filter ? JSON.parse(pref.source_filter) : null; } catch(_) {}

        for (const load of loads) {
          // Apply source filter — skip loads not matching the user's selected sources
          if (sourceFilter && Array.isArray(sourceFilter) && sourceFilter.length > 0) {
            const cat = load.sourceCategory || (load.source === 'FedEx' ? 'fedex' : 'usps');
            // 'usps' source: only USPS loads (sourceCategory === 'usps')
            // 'broker' source: both USPS and broker loads (sourceCategory === 'usps' or 'broker')
            // 'fedex' source: only FedEx loads (sourceCategory === 'fedex')
            let matchesSource = false;
            if (cat === 'fedex') {
              matchesSource = sourceFilter.includes('fedex');
            } else if (cat === 'broker') {
              // Telegram broker loads only show if 'broker' is selected
              matchesSource = sourceFilter.includes('broker');
            } else {
              // USPS loads show if either 'usps' or 'broker' is selected
              matchesSource = sourceFilter.includes('usps') || sourceFilter.includes('broker');
            }
            if (!matchesSource) continue;
          }

          const notifKey = `${pref.id}:${load.id}`;
          if (db.hasBeenNotified(telegramId, notifKey)) continue;

          const result = await matchesPreferences(load, pref, geocodedTrucks);
          if (result.matched) {
            await sendLoadNotification(parseInt(telegramId), load, pref, result);
            db.markNotified(telegramId, notifKey);
            notifCount++;
          }
        }
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[Monitor] ─── Cycle done in ${elapsed}s. ${notifCount} notifications sent.`);
  } catch (err) {
    console.error('[Monitor] Error:', err.message);
    global.lastScrapeInfo = { timestamp: new Date().toISOString(), error: err.message };
  }
}

async function sendLoadNotification(telegramId, load, pref, matchInfo) {
  // Format pickup time — display exactly as the source provides it, no timezone conversion
  let puTime = '';
  if (load.pickupTime) {
    const raw = load.pickupTime;
    const tz = load.pickupTimezone || 'ET';
    // Check if it's a parseable date (ISO string like "2026-05-09T19:00:00Z")
    const d = new Date(raw);
    if (!isNaN(d.getTime()) && raw.match(/^\d{4}-/)) {
      // Format using UTC methods since the time in the ISO string IS the local time
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const year = d.getUTCFullYear() % 100;
      let hours = d.getUTCHours();
      const minutes = d.getUTCMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      puTime = `${month}/${day}/${year}, ${hours}:${minutes} ${ampm} ${tz}`;
    } else {
      // Non-date string like "ASAP" — show as-is
      puTime = raw;
    }
  }

  const truckLabel = matchInfo.truck.label
    ? `${matchInfo.truck.label} (${matchInfo.truck.location})`
    : matchInfo.truck.location;

  const typeEmoji = load.loadType === 'TEAM' ? '👥' : load.loadType === 'SOLO' ? '👤' : '🚚';
  const statusEmoji = (load.status||'').toLowerCase().includes('expir') ? '🔴' :
                      (load.status||'').toLowerCase().includes('soon') ? '🟡' : '🟢';

  // Determine source label for the notification header
  const sourceLabel = load.source === 'FedEx' ? 'FedEx'
    : (load.sourceCategory === 'broker' ? 'Broker' : 'USPS');

  const lines = [
    `🔔 *New ${sourceLabel} Load Within Range!*`,
    ``,
    `🚛 *Nearest Truck:* ${truckLabel}`,
    `📏 *Distance to Pickup:* ${matchInfo.distanceMiles} miles`,
    ``,
    `🆔 Load \\#${load.loadNumber || load.id}`,
    `📍 *Pickup:* ${load.pickupLocation}`,
    `🏁 *Dropoff:* ${load.dropoffLocation}`,
  ];
  if (puTime)     lines.push(`📅 *Pickup Time:* ${puTime}`);
  if (load.miles) lines.push(`🛣️ *Trip Miles:* ${load.miles}`);
  if (load.loadType) lines.push(`${typeEmoji} *Type:* ${load.loadType}`);
  if (load.status) lines.push(`${statusEmoji} *Status:* ${load.status}`);

  // Add appropriate link based on source
  const loadboardBase = process.env.LOADBOARD_URL || 'https://loadboard.apps.tie.uz/';
  const boardUrl = load.source === 'FedEx'
    ? 'https://carrier-fedex.zuumapp.com/main/shipments'
    : (load.sourceCategory === 'broker' ? loadboardBase + '?tab=broker' : loadboardBase);
  lines.push(`\n🔗 [View on ${sourceLabel}](${boardUrl})`);

  try {
    await bot.sendMessage(telegramId, lines.join('\n'), {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: `🌐 Open ${sourceLabel}`, url: boardUrl }]] }
    });
    console.log(`[Monitor] ✅ Notified ${telegramId} — ${load.pickupLocation} near "${truckLabel}" (${matchInfo.distanceMiles}mi) [${load.loadType}]`);
  } catch (e) {
    console.error(`[Monitor] ❌ Notify failed for ${telegramId}:`, e.message);
  }
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────
cron.schedule(`*/${Math.max(1, Math.floor(CHECK_INTERVAL/60))} * * * *`, runMonitor);
cron.schedule('0 3 * * *', () => { db.cleanOldNotifications(); console.log('[DB] Cleaned old notifications'); });

app.listen(PORT, async () => {
  console.log(`🚀 Server on port ${PORT} | App: ${APP_URL} | Interval: ${CHECK_INTERVAL}s`);
  // Pre-warm geocode cache for all existing truck locations, then run first monitor cycle
  await prewarmTruckCache(db.getAllActivePreferences);
  setTimeout(runMonitor, 2000);
});

process.on('SIGINT', () => { console.log('\n👋 Shutdown'); process.exit(0); });
