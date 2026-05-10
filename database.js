const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'loadboard.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT, first_name TEXT, last_name TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT 'My Alert',
    pickup_location TEXT, dropoff_location TEXT,
    pickup_date TEXT, load_type TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );
  CREATE TABLE IF NOT EXISTS notified_loads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL, load_id TEXT NOT NULL,
    notified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(telegram_id, load_id)
  );
`);

// Safe migrations — each runs once
const migrations = [
  `ALTER TABLE preferences ADD COLUMN pickup_date_end TEXT`,
  `ALTER TABLE preferences ADD COLUMN trucks_text TEXT`,
  `ALTER TABLE preferences ADD COLUMN radius_miles INTEGER DEFAULT 100`,
  `ALTER TABLE preferences ADD COLUMN load_type_filter TEXT`,
  `ALTER TABLE preferences ADD COLUMN source_filter TEXT`,
];
for (const sql of migrations) { try { db.exec(sql); } catch (_) { } }

function upsertUser(tid, username, firstName, lastName) {
  return db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name) VALUES (?,?,?,?)
    ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,
      first_name=excluded.first_name, last_name=excluded.last_name
  `).run(tid, username, firstName, lastName);
}

function getAllActiveUsers() {
  return db.prepare('SELECT * FROM users WHERE is_active=1').all();
}

function savePreference(telegramId, pref) {
  const name = (pref.name && pref.name.trim()) || `Alert ${new Date().toLocaleDateString('en-US')}`;
  const radius = parseInt(pref.radiusMiles) || 100;
  const typeFilter = pref.loadTypeFilter || null; // 'TEAM', 'SOLO', or null
  // sourceFilter: JSON array like '["broker","fedex"]' or null (= all sources)
  const sourceFilter = Array.isArray(pref.sourceFilter) ? JSON.stringify(pref.sourceFilter) : (pref.sourceFilter || null);

  if (pref.id) {
    db.prepare(`
      UPDATE preferences SET
        name=?, trucks_text=?, pickup_date=?, pickup_date_end=?,
        radius_miles=?, load_type_filter=?, source_filter=?, is_active=?
      WHERE id=? AND telegram_id=?
    `).run(name, pref.trucksText, pref.pickupDate || null, pref.pickupDateEnd || null,
      radius, typeFilter, sourceFilter, pref.isActive ? 1 : 0, pref.id, telegramId);
    return { lastInsertRowid: pref.id };
  } else {
    return db.prepare(`
      INSERT INTO preferences (telegram_id,name,trucks_text,pickup_date,pickup_date_end,radius_miles,load_type_filter,source_filter)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(telegramId, name, pref.trucksText, pref.pickupDate || null, pref.pickupDateEnd || null, radius, typeFilter, sourceFilter);
  }
}

function deletePreference(telegramId, prefId) {
  return db.prepare('DELETE FROM preferences WHERE id=? AND telegram_id=?').run(prefId, telegramId);
}

function getUserPreferences(telegramId) {
  return db.prepare('SELECT * FROM preferences WHERE telegram_id=? ORDER BY created_at DESC').all(telegramId);
}

function getAllActivePreferences() {
  return db.prepare(`
    SELECT p.*, u.telegram_id as user_telegram_id FROM preferences p
    JOIN users u ON p.telegram_id=u.telegram_id
    WHERE p.is_active=1 AND u.is_active=1
  `).all();
}

function togglePreference(telegramId, prefId) {
  const pref = db.prepare('SELECT * FROM preferences WHERE id=? AND telegram_id=?').get(prefId, telegramId);
  if (!pref) return null;
  const newActive = pref.is_active ? 0 : 1;
  db.prepare('UPDATE preferences SET is_active=? WHERE id=?').run(newActive, prefId);
  return { is_active: !!newActive };
}

function hasBeenNotified(telegramId, loadId) {
  return !!db.prepare('SELECT id FROM notified_loads WHERE telegram_id=? AND load_id=?').get(telegramId, loadId);
}

function markNotified(telegramId, loadId) {
  try { db.prepare('INSERT OR IGNORE INTO notified_loads (telegram_id,load_id) VALUES (?,?)').run(telegramId, loadId); } catch (_) { }
}

function cleanOldNotifications() {
  db.prepare("DELETE FROM notified_loads WHERE notified_at < datetime('now','-7 days')").run();
}

module.exports = {
  upsertUser, getAllActiveUsers, savePreference, deletePreference,
  getUserPreferences, getAllActivePreferences, togglePreference,
  hasBeenNotified, markNotified, cleanOldNotifications,
};
