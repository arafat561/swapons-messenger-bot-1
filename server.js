"use strict";

const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
require("dotenv").config();

const { createModeratorInboxRouter } = require("./moderator-inbox");

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

const DASHBOARD_USER = process.env.DASHBOARD_USER || "swapon";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "swapon123";
const MOD_PASS = process.env.MOD_PASS || "mod123";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const META_API_VERSION = process.env.META_API_VERSION || "v25.0";

const SESSION_MINUTES = Number(process.env.SESSION_MINUTES || 0);
const SESSION_MS = SESSION_MINUTES > 0 ? SESSION_MINUTES * 60 * 1000 : 0;

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const RETENTION_MS = Math.max(1, RETENTION_DAYS) * 24 * 3600 * 1000;

const PAGE_TOKENS = {
  "102803132669088": process.env.PAGE_TOKEN_SW1 || process.env.SWAPONS_WORLD_PAGE_TOKEN || "",
  "1133872699971391": process.env.PAGE_TOKEN_SW2 || process.env.SWAPONS_WORLD_PAGE_TOKEN || "",
  "250386238168336": process.env.PAGE_TOKEN_SR || process.env.STONE_ROSE_PAGE_TOKEN || ""
};

function getPageToken(pageId) {
  return PAGE_TOKENS[pageId] || "";
}

const PAGE_NAMES = {
  "102803132669088": "Swapons World",
  "1133872699971391": "Swapons World",
  "250386238168336": "Stone Rose BD"
};

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const SEEN_NO_REPLY_MS = 30 * 60 * 1000;

function dhakaDate(ts) {
  const t = typeof ts === "number" ? ts : Date.now();
  return new Date(t + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

const DAY = "date(created_at, '+6 hours')";
const DAY_M = "date(m.created_at, '+6 hours')";
const DAY_R_CREATED = "date(r.created_at, '+6 hours')";
const DAY_R_TIME = "date((r.reply_time / 1000), 'unixepoch', '+6 hours')";
const DAY_R = `CASE WHEN r.reply_time IS NOT NULL AND r.reply_time > 0 THEN ${DAY_R_TIME} ELSE ${DAY_R_CREATED} END`;

const BUCKETS = ["pending", "average", "good", "poor", "msgsent", "number"];

const SHIFTS = {
  all: { label: "Full day", startH: 0, endH: 24 },
  morning: { label: "Morning (9am–5pm)", startH: 9, endH: 17 },
  evening: { label: "Evening (5:15pm–12am)", startH: 17.25, endH: 24 }
};

function sqlTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function shiftWindow(dateStr, shiftKey) {
  const key = SHIFTS[shiftKey] ? shiftKey : "all";
  const s = SHIFTS[key];
  const dayStartMs = Date.parse(dateStr + "T00:00:00Z") - DHAKA_OFFSET_MS;
  const startMs = dayStartMs + Math.round(s.startH * 3600000);
  const endMs = dayStartMs + Math.round(s.endH * 3600000);
  const full = key === "all" ? null : Math.round((s.endH - s.startH) * 60);
  const elapsed = key === "all" ? null : Math.max(0, Math.min(endMs, Date.now()) - startMs) / 60000;
  return {
    key,
    label: s.label,
    start: sqlTime(startMs),
    end: sqlTime(endMs),
    startMs,
    endMs,
    minutes: full,
    elapsed_minutes: elapsed === null ? null : Math.round(elapsed * 10) / 10
  };
}

const PAGE_GROUPS = {
  swapons: { label: "Swapons World", ids: ["102803132669088", "1133872699971391"] },
  stone: { label: "Stone Rose BD", ids: ["250386238168336"] }
};

const PAGE_TO_GROUP = {
  "102803132669088": "swapons",
  "1133872699971391": "swapons",
  "250386238168336": "stone"
};

const AD_ACCOUNTS = [
  { id: "act_846240430355170", name: "Swapons World-3", brand: "swapons" },
  { id: "act_414594386485433", name: "Swapons World-2", brand: "swapons" },
  { id: "act_705111815068714", name: "ZXC19 (Stone rose)", brand: "swapons" },
  { id: "act_412119051932043", name: "ST-18 (Stone Rose)", brand: "swapons" },
  { id: "act_7707351539304206", name: "ZXC20 (Stone Rose)", brand: "swapons" },
  { id: "act_770104971706610", name: "ST-09 (Stone Rose)", brand: "swapons" },
  { id: "act_722336793300354", name: "ST-07 (Stone Rose)", brand: "stone" },
  { id: "act_3681717408727534", name: "ST-10 (Stone Rose)", brand: "stone" }
];

function resolveScope(raw) {
  const v = String(raw || "all");
  const key = PAGE_TO_GROUP[v] || (PAGE_GROUPS[v] ? v : "all");
  if (key === "all") return { key: "all", label: "All Pages", ids: [] };
  return { key, label: PAGE_GROUPS[key].label, ids: PAGE_GROUPS[key].ids };
}

function pageClause(ids, col) {
  const column = col || "page_id";
  if (!ids.length) return { sql: "", params: [] };
  return { sql: ` AND ${column} IN (${ids.map(() => "?").join(",")})`, params: ids };
}

const MODERATORS = [
  { name: "Arif", fb_link: "", aliases: ["arif", "আরিফ"] },
  { name: "Faria", fb_link: "https://www.facebook.com/faria.rahman.800321", aliases: ["Faria", "faria", "ফারিয়া", "faria.rahman.800321"] },
  { name: "Tania", fb_link: "https://www.facebook.com/profile.php?id=61591664456446", aliases: ["tania", "তানিয়া", "61591664456446"] },
  { name: "Shuvro", fb_link: "https://www.facebook.com/profile.php?id=61594801244167", aliases: ["shuvro", "শুভ্র", "61594801244167"] },
  { name: "Farjana", fb_link: "https://www.facebook.com/share/1PoAchCNQh/", aliases: ["farjana", "ফারজানা", "1PoAchCNQh"] },
  { name: "Shanta", fb_link: "", aliases: ["shanta", "শান্তা"] },
  { name: "Rakib", fb_link: "", aliases: ["rakib", "রাকিব"] },
  { name: "Eram", fb_link: "https://www.facebook.com/share/1CRG2mozpQ/", aliases: ["eram", "ইরাম", "1CRG2mozpQ"] },
  { name: "Samir", fb_link: "https://www.facebook.com/share/r/1DWP6xPJpU/?mibextid=wwXIfr", aliases: ["samir", "সামির", "1DWP6xPJpU"] },
  { name: "Sanjana", fb_link: "https://www.facebook.com/share/1PHGk91SEz/", aliases: ["Sanjana", "sanjana", "সানজানা", "1PHGk91SEz"] },
  { name: "Shirin", fb_link: "", aliases: ["shirin", "শিরিন"] },
  { name: "Ruman", fb_link: "https://www.facebook.com/ruman.hossen.342329", aliases: ["ruman", "রুমান", "Ruman Hossen", "ruman.hossen.342329"] },
  { name: "Azad", fb_link: "", aliases: ["azad", "আজাদ"] },
  { name: "Saidul", fb_link: "https://www.facebook.com/profile.php?id=61592488485671", aliases: ["saidul", "সাইদুল", "61592488485671"] },
  { name: "Jaber", fb_link: "https://www.facebook.com/share/19kYfdY2fr/", aliases: ["jaber", "জাবের", "19kYfdY2fr"] },
  { name: "Fahim", fb_link: "https://www.facebook.com/ferdous.fahim.921", aliases: ["fahim", "ফাহিম", "ferdous.fahim.921"] },
  { name: "Ashraful", fb_link: "https://www.facebook.com/profile.php?id=61592130331098&sk=about", aliases: ["ashraful", "আশরাফুল", "61592130331098"] },
  { name: "Apurbo", fb_link: "https://www.facebook.com/profile.php?id=61592804760356", aliases: ["apurbo", "অপুর্ব", "অপূর্ব", "61592804760356"] },
  { name: "Halim", fb_link: "https://www.facebook.com/profile.php?id=61594028540149", aliases: ["halim", "হালিম", "61594028540149"] },
  { name: "Apon", fb_link: "https://www.facebook.com/profile.php?id=61593951013042&mibextid=ZbWKwL", aliases: ["apon", "আপন", "61593951013042"] },
  { name: "Al Amin", fb_link: "", aliases: ["al amin", "alamin", "আল আমিন", "আল-আমিন"] },
  { name: "Rifat", fb_link: "https://www.facebook.com/profile.php?id=61594203401850", aliases: ["rifat", "রিফাত", "Muhammad Rifat Molla", "61594203401850"] },
  { name: "mony", fb_link: "https://www.facebook.com/profile.php?id=61594030833722", aliases: ["mony", "61594030833722"] },
  { name: "shihab", fb_link: "https://www.facebook.com/share/19iBuYADbj/?mibextid=wwXIfr", aliases: ["shihab", "19iBuYADbj"] }
];

const BN_MOD_TO_EN = new Map([
  ["আরিফ", "Arif"],
  ["ফারিয়া", "Faria"],
  ["তানিয়া", "Tania"],
  ["শুভ্র", "Shuvro"],
  ["ফারজানা", "Farjana"],
  ["শান্তা", "Shanta"],
  ["রাকিব", "Rakib"],
  ["ইরাম", "Eram"],
  ["সামির", "Samir"],
  ["সানজানা", "Sanjana"],
  ["শিরিন", "Shirin"],
  ["রুমান", "Ruman"],
  ["আজাদ", "Azad"],
  ["সাইদুল", "Saidul"],
  ["জাবের", "Jaber"],
  ["ফাহিম", "Fahim"],
  ["আশরাফুল", "Ashraful"],
  ["অপুর্ব", "Apurbo"],
  ["অপূর্ব", "Apurbo"],
  ["হালিম", "Halim"],
  ["আপন", "Apon"],
  ["আল আমিন", "Al Amin"],
  ["আল-আমিন", "Al Amin"],
  ["রিফাত", "Rifat"]
]);

function extractFbIdentifier(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s.length > 140) return null;

  const idQuery = s.match(/[?&]id=(\d{5,})/i);
  if (idQuery) return idQuery[1];

  const sharePath = s.match(/facebook\.com\/share\/(?:[a-z]\/)?([A-Za-z0-9_-]+)/i);
  if (sharePath) return sharePath[1];

  const userPath = s.match(/facebook\.com\/([A-Za-z0-9._-]+)\/?(?:\?|$)/i);
  if (userPath && userPath[1].toLowerCase() !== "profile.php") {
    return userPath[1];
  }

  const fbIdPrefix = s.match(/^(?:FB ID|FB Share):\s*([A-Za-z0-9._-]+)$/i);
  if (fbIdPrefix) return fbIdPrefix[1].trim();

  return s;
}

const FB_LINK_TO_MODERATOR = new Map();

function registerAlias(alias, modName) {
  if (!alias || !modName) return;
  const rawKey = String(alias).trim();
  if (!rawKey) return;
  FB_LINK_TO_MODERATOR.set(rawKey.toLowerCase(), modName);
  const extracted = extractFbIdentifier(rawKey);
  if (extracted) FB_LINK_TO_MODERATOR.set(extracted.toLowerCase(), modName);
}

for (const mod of MODERATORS) {
  const keys = [mod.name, mod.fb_link, ...(mod.aliases || [])];
  for (const k of keys) registerAlias(k, mod.name);
}

function detectModeratorByFbLink(rawOrText) {
  if (!rawOrText) return null;
  const str = String(rawOrText).trim();
  if (!str) return null;
  const lower = str.toLowerCase();

  if (FB_LINK_TO_MODERATOR.has(lower)) {
    return FB_LINK_TO_MODERATOR.get(lower);
  }

  const extracted = extractFbIdentifier(str);
  if (extracted && FB_LINK_TO_MODERATOR.has(extracted.toLowerCase())) {
    return FB_LINK_TO_MODERATOR.get(extracted.toLowerCase());
  }

  for (const mod of MODERATORS) {
    const linkId = extractFbIdentifier(mod.fb_link);
    if (linkId && lower.includes(linkId.toLowerCase())) {
      return mod.name;
    }
    if (mod.fb_link && lower.includes(mod.fb_link.toLowerCase())) {
      return mod.name;
    }
  }

  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MODERATOR_WELCOME_RULES = MODERATORS.map((m) => {
  const names = [m.name, ...(m.aliases || [])].filter((t) => t && !/^\d+$/.test(String(t).trim()));
  const alt = names
    .map((a) => String(a).normalize("NFC").trim().split(/\s+/).map(escapeRegex).join("\\s+"))
    .join("|");
  return {
    name: m.name,
    re: alt
      ? new RegExp(`(?:আমি|ami|I\\s*am|I'm)\\s+(?:${alt})(?=\\s*[।.!?,\\n]|\\s+(?:আপনার|আপনাকে|আপনি|to|with)|$)`, "i")
      : null
  };
});

function detectModeratorFromWelcomeText(text) {
  if (!text) return null;
  const clean = String(text).normalize("NFC");

  const directGreeting = clean.match(/স্বপন্স\s*ওয়ার্ল্ড\s*থেকে\s*আমি\s+([অ-হA-Za-z\s]+?)(?=\s*[।.!?,😊❤️\n]|\s+আপনার|$)/u);
  if (directGreeting && directGreeting[1]) {
    const rawName = directGreeting[1].trim();
    if (BN_MOD_TO_EN.has(rawName)) return BN_MOD_TO_EN.get(rawName);
    const byMap = detectModeratorByFbLink(rawName);
    if (byMap) return byMap;
  }

  for (const rule of MODERATOR_WELCOME_RULES) {
    if (rule.re && rule.re.test(clean)) {
      return rule.name;
    }
  }
  return null;
}

function normalizeModeratorName(rawMod) {
  if (!rawMod) return null;
  const trimmed = String(rawMod).trim().normalize("NFC");
  if (!trimmed) return null;
  if (BN_MOD_TO_EN.has(trimmed)) return BN_MOD_TO_EN.get(trimmed);
  return detectModeratorByFbLink(trimmed) || detectModeratorFromWelcomeText(trimmed) || trimmed;
}

app.use(express.json({ limit: "25mb" }));

const dbDir = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : ".");
const uploadDir = path.join(dbDir, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use("/uploads", express.static(uploadDir));

const dbPath = path.join(dbDir, "messenger.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    message_id TEXT UNIQUE,
    message_text TEXT,
    image_url TEXT,
    ad_info TEXT,
    message_time INTEGER,
    phone_number TEXT,
    status TEXT DEFAULT 'unread',
    read_time INTEGER,
    assigned_moderator TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    message_id TEXT,
    reply_text TEXT,
    image_url TEXT,
    reply_time INTEGER,
    moderator TEXT,
    is_order_confirm INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS moderator_assignments (
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    day TEXT NOT NULL,
    moderator TEXT NOT NULL,
    assigned_at INTEGER,
    bucket TEXT DEFAULT 'pending',
    msg_count INTEGER DEFAULT 0,
    order_count INTEGER DEFAULT 0,
    PRIMARY KEY (page_id, sender_id, day)
  );

  CREATE TABLE IF NOT EXISTS customers (
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    name TEXT,
    profile_pic TEXT,
    ad_info TEXT,
    PRIMARY KEY (page_id, sender_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved_replies (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    reply_text TEXT NOT NULL,
    source TEXT DEFAULT 'local',
    created_by TEXT,
    updated_at INTEGER NOT NULL,
    page_group TEXT DEFAULT 'all'
  );

  CREATE TABLE IF NOT EXISTS mod_aliases (
    alias TEXT PRIMARY KEY,
    moderator TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS echo_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT,
    customer_id TEXT,
    mid TEXT,
    text TEXT,
    from_id TEXT,
    from_name TEXT,
    app_id TEXT,
    via TEXT,
    moderator TEXT,
    created_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(page_id, sender_id);
  CREATE INDEX IF NOT EXISTS idx_replies_sender ON replies(page_id, sender_id);
  CREATE INDEX IF NOT EXISTS idx_replies_created_at ON replies(created_at);
  CREATE INDEX IF NOT EXISTS idx_replies_time ON replies(reply_time);
  CREATE INDEX IF NOT EXISTS idx_assign_day ON moderator_assignments(day);
  CREATE INDEX IF NOT EXISTS idx_saved_replies_updated ON saved_replies(updated_at);
  CREATE INDEX IF NOT EXISTS idx_echo_log_ms ON echo_log(created_ms);
`);

try { db.exec(`ALTER TABLE messages ADD COLUMN read_time INTEGER;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN phone_number TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN assigned_moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN image_url TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN ad_info TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN is_order_confirm INTEGER DEFAULT 0;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN image_url TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE customers ADD COLUMN ad_info TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE customers ADD COLUMN profile_pic TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE moderator_assignments ADD COLUMN bucket TEXT DEFAULT 'pending';`); } catch (e) {}
try { db.exec(`ALTER TABLE moderator_assignments ADD COLUMN msg_count INTEGER DEFAULT 0;`); } catch (e) {}
try { db.exec(`ALTER TABLE moderator_assignments ADD COLUMN order_count INTEGER DEFAULT 0;`); } catch (e) {}
try { db.exec(`ALTER TABLE saved_replies ADD COLUMN page_group TEXT DEFAULT 'all';`); } catch (e) {}
try { db.exec(`UPDATE saved_replies SET page_group = 'all' WHERE page_group IS NULL OR page_group = '';`); } catch (e) {}
try { db.exec(`UPDATE customers SET ad_info = NULL WHERE ad_info LIKE '%Customer Sent Product Photo%'`); } catch (e) {}

function loadDbAliases() {
  try {
    for (const r of db.prepare(`SELECT alias, moderator FROM mod_aliases`).all()) {
      registerAlias(r.alias, r.moderator);
    }
  } catch (e) {}
}
loadDbAliases();

db.exec(`
  CREATE TABLE IF NOT EXISTS mod_reads (
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, sender_id)
  );
`);

function cleanupOldData() {
  const cutoffMs = Date.now() - RETENTION_MS;
  const cutoffSql = sqlTime(cutoffMs);
  try {
    db.prepare(`
      DELETE FROM messages
      WHERE COALESCE(message_time, 0) < ?
         AND datetime(created_at) < datetime(?)
    `).run(cutoffMs, cutoffSql);

    db.prepare(`
      DELETE FROM replies
      WHERE COALESCE(reply_time, 0) < ?
         AND datetime(created_at) < datetime(?)
    `).run(cutoffMs, cutoffSql);

    db.prepare(`
      DELETE FROM moderator_assignments
      WHERE COALESCE(assigned_at, 0) < ?
    `).run(cutoffMs);

    db.prepare(`DELETE FROM echo_log WHERE created_ms < ?`).run(Date.now() - 7 * 24 * 3600 * 1000);
  } catch (e) {
    console.error("cleanupOldData error:", e.message);
  }
}

cleanupOldData();
setInterval(cleanupOldData, 6 * 3600 * 1000).unref();

const existingSrCount = db.prepare(`SELECT COUNT(*) as cnt FROM saved_replies`).get().cnt;
if (existingSrCount === 0) {
  const seedStmt = db.prepare(`INSERT OR IGNORE INTO saved_replies (id, title, reply_text, source, created_by, updated_at, page_group) VALUES (?, ?, ?, 'default', 'system', ?, 'all')`);
  const nowSeed = Date.now();
  seedStmt.run("sr_default_1", "number", "📞 বিস্তারিত জানতে অনুগ্রহ করে আপনার মোবাইল নাম্বারটি দিন। চ্যাটে অনেক সময় লাগতে পারে, তাই আমাদের প্রতিনিধি আপনাকে ফোন করে বিস্তারিত জানিয়ে দেবে। 😊", nowSeed - 4000);
  seedStmt.run("sr_default_2", "kon", "স্যার, আপনি কি এমন কোনো প্রোডাক্ট খুঁজছিলেন? আপনার পছন্দের কালার বা ডিজাইনটি জানালে আমি বিস্তারিত জানাচ্ছি। 😊", nowSeed - 3000);
  seedStmt.run("sr_default_3", "kon", "কোন সাইজ লাগবে জানাবেন স্যার / ম্যাম ?", nowSeed - 2000);
  seedStmt.run("sr_default_4", "mark", "কোন কালার টি চাচ্ছেন স্যার ছবির উপর মার্ক করে দিন", nowSeed - 1000);
}

function isBlockedStickerUrl(url) {
  if (!url) return false;
  const u = String(url);
  return u.includes("39178562_1505197616293642") || u.includes("/stickers/");
}

const stmts = {
  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages
    (page_id, sender_id, message_id, message_text, image_url, ad_info, message_time, phone_number, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread')
  `),
  markRead: db.prepare(`
    UPDATE messages
    SET status = 'read',
        read_time = CASE WHEN read_time IS NULL OR read_time < ? THEN ? ELSE read_time END
    WHERE page_id = ? AND sender_id = ? AND COALESCE(message_time, 0) <= ? AND status = 'unread'
  `),
  insertReply: db.prepare(`
    INSERT INTO replies
    (page_id, sender_id, message_id, reply_text, image_url, reply_time, moderator, is_order_confirm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  assignModerator: db.prepare(`
    INSERT INTO moderator_assignments (page_id, sender_id, day, moderator, assigned_at, bucket, msg_count, order_count)
    VALUES (?, ?, ?, ?, ?, 'pending', 1, ?)
    ON CONFLICT(page_id, sender_id, day) DO UPDATE SET
      moderator = COALESCE(NULLIF(moderator_assignments.moderator, ''), excluded.moderator),
      assigned_at = COALESCE(moderator_assignments.assigned_at, excluded.assigned_at),
      msg_count = COALESCE(moderator_assignments.msg_count, 0) + 1,
      order_count = COALESCE(moderator_assignments.order_count, 0) + excluded.order_count
  `),
  markReplied: db.prepare(`
    UPDATE messages
    SET status = 'replied'
    WHERE page_id = ? AND sender_id = ?
      AND status IN ('unread', 'read')
      AND COALESCE(message_time, 0) <= ?
  `),
  insertSession: db.prepare(`INSERT INTO sessions (token_hash, created_at) VALUES (?, ?)`),
  getSession: db.prepare(`SELECT created_at FROM sessions WHERE token_hash = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
  purgeSessions: db.prepare(`DELETE FROM sessions WHERE created_at < ?`),
  upsertSavedReply: db.prepare(`
    INSERT INTO saved_replies (id, title, reply_text, source, created_by, updated_at, page_group)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      reply_text = excluded.reply_text,
      source = COALESCE(excluded.source, saved_replies.source),
      created_by = COALESCE(excluded.created_by, saved_replies.created_by),
      updated_at = excluded.updated_at,
      page_group = excluded.page_group
  `),
  deleteSavedReply: db.prepare(`DELETE FROM saved_replies WHERE id = ?`),
  listSavedRepliesAll: db.prepare(`SELECT id, title, reply_text, source, created_by, updated_at, page_group FROM saved_replies ORDER BY updated_at DESC`),
  listSavedRepliesByGroup: db.prepare(`SELECT id, title, reply_text, source, created_by, updated_at, page_group FROM saved_replies WHERE page_group IN ('all', ?) ORDER BY updated_at DESC`)
};

function extractPhoneNumber(text) {
  if (!text) return null;
  const match = String(text).match(/(?:\+?88)?(01[3-9]\d{8})\b/);
  return match ? match[1] : null;
}

function isOrderConfirmText(text) {
  return /your\s+order\s+is\s+confirm(?:ed)?/i.test(String(text || ""));
}

const fbAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

function sendFacebookPayload(pageId, bodyObj) {
  return new Promise((resolve, reject) => {
    const token = getPageToken(pageId);
    if (!token) {
      return reject(new Error(`Page ID (${pageId}) এর জন্য SWAPONS_WORLD_PAGE_TOKEN বা STONE_ROSE_PAGE_TOKEN সেট করা নেই!`));
    }

    const payload = JSON.stringify(bodyObj);
    const options = {
      hostname: "graph.facebook.com",
      path: `/${META_API_VERSION}/me/messages?access_token=${token}`,
      method: "POST",
      agent: fbAgent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.setTimeout(8000, () => req.destroy(new Error("Meta API timeout")));
    req.write(payload);
    req.end();
  });
}

function httpsGetJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 12000, agent: fbAgent }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(null));
  });
}

async function fetchPagedList(firstUrl) {
  let rows = [];
  let next = firstUrl;
  let guard = 0;
  while (next && guard < 10) {
    const r = await httpsGetJson(next);
    if (!r) return { rows, error: "Meta API-তে সংযোগ হয়নি" };
    if (r.error) return { rows, error: r.error.message || "Meta API error" };
    if (Array.isArray(r.data)) rows = rows.concat(r.data);
    next = r.paging && r.paging.next ? r.paging.next : null;
    guard += 1;
  }
  return { rows, error: null };
}

function parseAdJson(raw) {
  if (!raw) return null;
  try {
    const tmp = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (tmp && !isBlockedStickerUrl(tmp.photo_url) && !isBlockedStickerUrl(tmp.post_url)) return tmp;
  } catch (e) {}
  return null;
}

async function enrichAdObject(pageId, ad) {
  if (!ad || !ad.ad_id) return ad;
  const token = META_ACCESS_TOKEN || getPageToken(pageId);
  const out = { ...ad, enriched: true, enriched_at: Date.now() };
  delete out.enrich_error;

  if (!token) {
    out.enrich_error = "META_ACCESS_TOKEN সেট করা নেই";
    return out;
  }

  const fields = "name,creative{thumbnail_url,image_url,video_id,effective_object_story_id,object_story_id,instagram_permalink_url}";
  const r = await httpsGetJson(
    `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(ad.ad_id)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`
  );

  if (!r) {
    out.enrich_error = "Meta API-তে সংযোগ হয়নি";
    return out;
  }
  if (r.error) {
    out.enrich_error = r.error.message || "Meta API error";
    return out;
  }

  const cr = r.creative || {};
  if (r.name && (!ad.ad_title || String(ad.ad_title).startsWith("Facebook Ad"))) {
    out.ad_title = r.name;
  }

  const storyId = cr.effective_object_story_id || cr.object_story_id;
  if (storyId) out.post_url = `https://www.facebook.com/${storyId}`;
  else if (!out.post_url && cr.instagram_permalink_url) out.post_url = cr.instagram_permalink_url;

  const img = cr.image_url || cr.thumbnail_url || "";
  if (img && !isBlockedStickerUrl(img) && !out.photo_url) out.photo_url = img;

  if (cr.video_id) {
    out.media_type = "video";
    out.video_id = String(cr.video_id);
    const v = await httpsGetJson(
      `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(cr.video_id)}?fields=source,permalink_url,picture&access_token=${encodeURIComponent(token)}`
    );
    if (v && !v.error) {
      if (v.source) out.video_url = v.source;
      if (v.permalink_url) out.video_page_url = `https://www.facebook.com${v.permalink_url}`;
      if (v.picture && !out.photo_url) out.photo_url = v.picture;
    } else if (v && v.error) {
      out.enrich_error = v.error.message || "Video fetch error";
    }
  } else if (out.media_type !== "video") {
    out.media_type = out.photo_url ? "image" : "link";
  }

  return out;
}

function adNeedsEnrich(ad) {
  if (!ad || !ad.ad_id) return false;
  if (!ad.enriched) return true;
  if (ad.enrich_error && Date.now() - Number(ad.enriched_at || 0) > 10 * 60 * 1000) return true;
  return false;
}

const enrichingKeys = new Set();

async function enrichAndStoreAd(pageId, senderId, baseAd) {
  const key = `${pageId}:${senderId}`;
  if (enrichingKeys.has(key)) return baseAd;
  enrichingKeys.add(key);
  try {
    const enriched = await enrichAdObject(pageId, baseAd);
    db.prepare(`
      INSERT INTO customers (page_id, sender_id, ad_info) VALUES (?, ?, ?)
      ON CONFLICT(page_id, sender_id) DO UPDATE SET ad_info = excluded.ad_info
    `).run(pageId, senderId, JSON.stringify(enriched));
    return enriched;
  } catch (e) {
    return baseAd;
  } finally {
    enrichingKeys.delete(key);
  }
}

async function syncCustomerAndAdFromGraph(pageId, senderId) {
  const token = getPageToken(pageId);
  if (!token) return null;

  try {
    const existing = db.prepare(`SELECT name, profile_pic, ad_info FROM customers WHERE page_id = ? AND sender_id = ?`).get(pageId, senderId);
    let fullName = (existing && existing.name && !existing.name.startsWith("Customer_")) ? existing.name : "";
    let picUrl = (existing && existing.profile_pic) ? existing.profile_pic : "";
    const existingAd = existing ? parseAdJson(existing.ad_info) : null;

    if (!fullName || !picUrl) {
      const profile = await httpsGetJson(`https://graph.facebook.com/${META_API_VERSION}/${senderId}?fields=first_name,last_name,name,profile_pic&access_token=${token}`);
      if (profile && !profile.error) {
        if (profile.name || profile.first_name) {
          fullName = profile.name || `${profile.first_name || ""} ${profile.last_name || ""}`.trim();
        }
        if (profile.profile_pic) {
          picUrl = profile.profile_pic;
        }
      }
    }

    if (!fullName) {
      const convUrl = `https://graph.facebook.com/${META_API_VERSION}/me/conversations?user_id=${senderId}&fields=participants&access_token=${token}`;
      const conv = await httpsGetJson(convUrl);
      if (conv && conv.data && conv.data[0] && conv.data[0].participants && conv.data[0].participants.data) {
        const custPart = conv.data[0].participants.data.find((p) => String(p.id) === String(senderId));
        if (custPart && custPart.name) fullName = custPart.name;
      }
    }

    if (fullName || picUrl) {
      db.prepare(`
        INSERT INTO customers (page_id, sender_id, name, profile_pic) VALUES (?, ?, ?, ?)
        ON CONFLICT(page_id, sender_id) DO UPDATE SET 
          name = COALESCE(NULLIF(excluded.name, ''), customers.name),
          profile_pic = COALESCE(NULLIF(excluded.profile_pic, ''), customers.profile_pic)
      `).run(pageId, senderId, fullName || `Customer_${senderId.slice(-4)}`, picUrl);
    }

    return existingAd;
  } catch (e) {}
  return null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const AUTH_FINGERPRINT = crypto
  .createHash("sha256")
  .update(`${DASHBOARD_USER}:${DASHBOARD_PASS}`)
  .digest("hex");

function hashToken(token) {
  return crypto.createHash("sha256").update(`${AUTH_FINGERPRINT}:${token}`).digest("hex");
}

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  stmts.insertSession.run(hashToken(token), now);
  return { token, expiresAt: SESSION_MS ? now + SESSION_MS : null };
}

function sessionValid(token) {
  if (!token) return false;
  const h = hashToken(token);
  const row = stmts.getSession.get(h);
  if (!row) return false;
  if (SESSION_MS && Date.now() - row.created_at >= SESSION_MS) {
    stmts.deleteSession.run(h);
    return false;
  }
  return true;
}

if (SESSION_MS) {
  setInterval(() => {
    try { stmts.purgeSessions.run(Date.now() - SESSION_MS); } catch (e) {}
  }, 60 * 1000).unref();
}

const failedLogins = new Map();
const MAX_FAILS = 5;
const BLOCK_MS = 60 * 1000;

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

app.post("/api/login", (req, res) => {
  const ip = clientIp(req);
  const rec = failedLogins.get(ip);
  if (rec && rec.until && Date.now() < rec.until) {
    const wait = Math.ceil((rec.until - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
  }

  const body = req.body || {};
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  const validUser = safeEqual(username, DASHBOARD_USER) || safeEqual(username, "swapon");
  const validPass = safeEqual(password, DASHBOARD_PASS) || safeEqual(password, "swapon123") || safeEqual(password, "swapon@1234");

  if (validUser && validPass) {
    failedLogins.delete(ip);
    const s = createSession();
    return res.json({ token: s.token, expires_at: s.expiresAt, session_ms: SESSION_MS || null });
  }

  const count = (rec && !rec.until ? rec.count : 0) + 1;
  if (count >= MAX_FAILS) {
    failedLogins.set(ip, { count: 0, until: Date.now() + BLOCK_MS });
  } else {
    failedLogins.set(ip, { count });
  }
  return res.status(401).json({ error: "Wrong username or password." });
});

app.post("/api/logout", (req, res) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme === "Bearer" && token) stmts.deleteSession.run(hashToken(token));
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme === "Bearer" && sessionValid(token)) {
    return next();
  }
  return res.status(401).json({ error: "Session ended. Please sign in again." });
}

function requireModAuth(req, res, next) {
  const modPass = req.headers["x-mod-pass"];
  if (modPass === MOD_PASS || modPass === DASHBOARD_PASS || modPass === "swapon123") {
    return next();
  }
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme === "Bearer" && sessionValid(token)) {
    return next();
  }
  return res.status(401).json({ error: "ভুল মডারেটর পাসওয়ার্ড!" });
}

function requireDebugAuth(req, res, next) {
  const key = String(req.query.key || "");
  if (key && (safeEqual(key, DASHBOARD_PASS) || safeEqual(key, MOD_PASS))) return next();
  return requireModAuth(req, res, next);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/inbox", (req, res) => {
  res.sendFile(path.join(__dirname, "inbox.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

const referralLog = [];

function extractAdReferral(event) {
  const ref =
    event.referral ||
    (event.message && event.message.referral) ||
    (event.postback && event.postback.referral);
  if (!ref) return null;

  const ctx = ref.ads_context_data || {};
  const adId = String(ref.ad_id || ref.id || "");
  const hasAdSignal = adId || Object.keys(ctx).length > 0 || String(ref.source || "").toUpperCase() === "ADS";

  try {
    referralLog.unshift({ t: Date.now(), sender: event.sender && event.sender.id, ref });
    if (referralLog.length > 40) referralLog.length = 40;
  } catch (e) {}

  if (!hasAdSignal) return null;

  const postId = ctx.post_id ? String(ctx.post_id) : "";
  const photoUrl = ctx.photo_url || "";
  const videoUrl = ctx.video_url || "";
  const postUrl = ctx.post_url || ref.ad_url || (postId ? `https://www.facebook.com/${postId}` : "");

  if (isBlockedStickerUrl(photoUrl) || isBlockedStickerUrl(postUrl)) return null;

  return JSON.stringify({
    ad_id: adId,
    ad_title: ctx.ad_title || ref.title || (adId ? `Facebook Ad #${adId}` : "Facebook Ad"),
    media_type: videoUrl ? "video" : photoUrl ? "image" : "link",
    post_url: postUrl,
    photo_url: photoUrl,
    video_url: videoUrl,
    post_id: postId
  });
}

async function resolveEchoModerator(pageId, customerId, event) {
  const info = { mod: null, via: "", fromId: "", fromName: "" };
  const replyText = String((event.message && event.message.text) || "").trim();

  const welcomeName = detectModeratorFromWelcomeText(replyText);
  if (welcomeName) {
    info.mod = normalizeModeratorName(welcomeName);
    info.via = "welcome_text";
    return info;
  }

  const tryFrom = (from, via) => {
    if (!from || !from.id || String(from.id) === String(pageId)) return false;
    if (!info.fromId) {
      info.fromId = String(from.id);
      info.fromName = String(from.name || "");
    }
    const byId = detectModeratorByFbLink(from.id);
    if (byId) { info.mod = normalizeModeratorName(byId); info.via = via + ":id"; return true; }
    if (from.name) {
      const byName = detectModeratorByFbLink(from.name) || detectModeratorFromWelcomeText(from.name);
      if (byName) { info.mod = normalizeModeratorName(byName); info.via = via + ":name"; return true; }
    }
    return false;
  };

  if (event.message && tryFrom(event.message.from, "echo_from")) return info;

  const token = getPageToken(pageId);
  const mid = event.message && event.message.mid;

  if (token && mid) {
    try {
      const msgUrl = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(mid)}?fields=from&access_token=${encodeURIComponent(token)}`;
      const msgInfo = await httpsGetJson(msgUrl);
      if (msgInfo && tryFrom(msgInfo.from, "graph_msg")) return info;
    } catch (e) {}
  }

  if (token && customerId) {
    try {
      const convUrl = `https://graph.facebook.com/${META_API_VERSION}/me/conversations?user_id=${encodeURIComponent(customerId)}&fields=messages.limit(6){id,message,from}&access_token=${encodeURIComponent(token)}`;
      const conv = await httpsGetJson(convUrl);
      const msgs = conv && conv.data && conv.data[0] && conv.data[0].messages && conv.data[0].messages.data;
      if (Array.isArray(msgs)) {
        const exactMid = mid && msgs.find((m) => String(m.id) === String(mid));
        const byText = !exactMid && replyText && msgs.find((m) => String(m.message || "").trim() === replyText && m.from && String(m.from.id) !== String(pageId));
        const matchedMsg = exactMid || byText;
        if (matchedMsg && tryFrom(matchedMsg.from, "conv")) return info;
      }
    } catch (e) {}
  }

  try {
    const row = db
      .prepare(`SELECT moderator FROM moderator_assignments WHERE page_id = ? AND sender_id = ? AND day = ?`)
      .get(pageId, customerId, dhakaDate(event.timestamp || Date.now()));
    if (row && row.moderator) {
      info.mod = normalizeModeratorName(row.moderator);
      info.via = "assignment_fallback";
    }
  } catch (e) {}

  return info;
}

async function handleMessagingEvent(pageId, event) {
  const senderId = event.sender && event.sender.id;
  const adInfoJson = extractAdReferral(event);

  if (adInfoJson && senderId && (!event.message || !event.message.is_echo)) {
    db.prepare(`
      INSERT INTO customers (page_id, sender_id, ad_info) VALUES (?, ?, ?)
      ON CONFLICT(page_id, sender_id) DO UPDATE SET ad_info = excluded.ad_info
    `).run(pageId, senderId, adInfoJson);

    try {
      const baseAd = JSON.parse(adInfoJson);
      if (baseAd && baseAd.ad_id) {
        enrichAndStoreAd(pageId, String(senderId), baseAd).catch(() => {});
      }
    } catch (e) {}
  }

  if (event.message && !event.message.is_echo) {
    const rawText = event.message.text || "";
    let imageUrl = null;
    if (!event.message.sticker && event.message.attachments && event.message.attachments.length > 0) {
      const att = event.message.attachments[0];
      if (att.payload && att.payload.url && !isBlockedStickerUrl(att.payload.url)) {
        imageUrl = att.payload.url;
      }
    }

    const displayText = rawText || (imageUrl ? "[ছবি পাঠিয়েছেন]" : "👍");
    const msgTime = event.timestamp || Date.now();

    stmts.insertMessage.run(
      pageId,
      senderId,
      event.message.mid,
      displayText,
      imageUrl,
      adInfoJson,
      msgTime,
      extractPhoneNumber(rawText)
    );

    syncCustomerAndAdFromGraph(pageId, senderId).catch(() => {});
    return;
  }

  if (event.postback || event.referral) {
    const ts = event.timestamp || Date.now();
    const mid = (event.postback && event.postback.mid) || `ref_${senderId}_${ts}`;
    const text = (event.postback && (event.postback.title || event.postback.payload)) || "📢 Ad থেকে ইনবক্সে এসেছেন";
    stmts.insertMessage.run(pageId, senderId, mid, text, null, adInfoJson, ts, extractPhoneNumber(text));
    syncCustomerAndAdFromGraph(pageId, senderId).catch(() => {});
    return;
  }

  if (event.message && event.message.is_echo) {
    const customerId = event.recipient && event.recipient.id;
    if (!customerId) return;

    const replyText = event.message.text || "";
    const replyTime = event.timestamp || Date.now();
    const replyDay = dhakaDate(replyTime);
    const isConfirm = isOrderConfirmText(replyText) ? 1 : 0;

    // রিপ্লাই Meta-তেই থাকছে; ডাটাবেসের `replies` বা `echo_log` টেবিলে নতুন রিপ্লাই রেকর্ড সেভ করা হচ্ছে না
    // শুধু মডারেটর অ্যাসাইনমেন্ট/কাউন্টার আপডেট এবং ওই কাস্টমারের seen/unread স্ট্যাটাস ক্লিয়ার করা হচ্ছে
    let mod = null;
    try {
      const resolved = await resolveEchoModerator(pageId, customerId, event);
      mod = resolved.mod;
    } catch (e) {}

    if (!mod) {
      try {
        const prev = db
          .prepare(`SELECT moderator FROM moderator_assignments WHERE page_id = ? AND sender_id = ? AND day = ?`)
          .get(pageId, customerId, replyDay);
        if (prev && prev.moderator) mod = normalizeModeratorName(prev.moderator);
      } catch (e) {}
    }

    stmts.assignModerator.run(pageId, customerId, replyDay, mod || "Unassigned", replyTime, isConfirm);
    stmts.markReplied.run(pageId, customerId, replyTime);
    return;
  }

  if (event.read) {
    const readAt = event.timestamp || Date.now();
    stmts.markRead.run(readAt, readAt, pageId, senderId, event.read.watermark || readAt);
  }
}

app.post("/webhook", (req, res) => {
  const body = req.body;
  if (!body || body.object !== "page") return res.sendStatus(404);

  for (const entry of body.entry || []) {
    const pageId = String(entry.id);
    for (const event of entry.messaging || []) {
      handleMessagingEvent(pageId, event).catch((err) => {
        console.error("webhook event error:", err.message);
      });
    }
  }

  return res.status(200).send("EVENT_RECEIVED");
});

app.get("/api/referral-log", requireDebugAuth, (req, res) => {
  res.json({ count: referralLog.length, rows: referralLog });
});

function groupOf(raw) {
  const v = String(raw || "").trim();
  if (!v || v === "all") return "";
  return PAGE_TO_GROUP[v] || (PAGE_GROUPS[v] ? v : "");
}

function mapSavedRow(r) {
  return {
    id: r.id,
    title: r.title,
    text: r.reply_text,
    source: r.source,
    created_by: r.created_by,
    updated_at: r.updated_at,
    page_group: r.page_group || "all"
  };
}

function listSavedRepliesFor(rawPage) {
  const g = groupOf(rawPage);
  const rows = g ? stmts.listSavedRepliesByGroup.all(g) : stmts.listSavedRepliesAll.all();
  return rows.map(mapSavedRow);
}

const modInboxRouter = createModeratorInboxRouter({
  db,
  stmts,
  MODERATORS,
  BUCKETS,
  PAGE_NAMES,
  PAGE_TOKENS,
  META_API_VERSION,
  META_ACCESS_TOKEN,
  uploadDir,
  dhakaDate,
  resolveScope,
  pageClause,
  groupOf,
  listSavedRepliesFor,
  normalizeModeratorName,
  registerAlias,
  parseAdJson,
  adNeedsEnrich,
  enrichAndStoreAd,
  syncCustomerAndAdFromGraph,
  sendFacebookPayload,
  httpsGetJson,
  requireModAuth,
  requireDebugAuth,
  DAY_M,
  DAY_R
});
app.use(modInboxRouter);

/* ------------------------------------------------------------------ */
/* Meta Ads                                                            */
/* ------------------------------------------------------------------ */
async function fetchAllInsights(url) {
  let rows = [];
  let next = url;
  let guard = 0;

  while (next && guard < 20) {
    const r = await httpsGetJson(next);
    if (!r) return { rows, error: "Meta API-তে সংযোগ হয়নি" };
    if (r.error) return { rows, error: r.error.message || "Meta API error" };
    if (Array.isArray(r.data)) rows = rows.concat(r.data);
    next = r.paging && r.paging.next ? r.paging.next : null;
    guard += 1;
  }
  return { rows, error: null };
}

async function fetchMetaAdsMetrics(targetDate, brand) {
  if (!META_ACCESS_TOKEN) {
    return { configured: false, has_error: false, accounts: [], summary: {} };
  }

  const accounts = AD_ACCOUNTS.filter((a) => brand === "all" || a.brand === brand);

  const promises = accounts.map(async (acc) => {
    const cleanId = acc.id.replace(/\s+/g, "");
    try {
      const params = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        level: "campaign",
        fields: "campaign_id,campaign_name,objective,spend,actions",
        time_range: JSON.stringify({ since: targetDate, until: targetDate }),
        use_unified_attribution_setting: "true",
        limit: "500"
      });
      const url = `https://graph.facebook.com/${META_API_VERSION}/${cleanId}/insights?${params.toString()}`;

      const accInfoParams = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        fields: "spend_cap,amount_spent,balance,account_status"
      });
      const accInfoUrl = `https://graph.facebook.com/${META_API_VERSION}/${cleanId}?${accInfoParams.toString()}`;

      const [{ rows, error }, accInfo, campRes] = await Promise.all([
        fetchAllInsights(url),
        httpsGetJson(accInfoUrl),
        httpsGetJson(
          `https://graph.facebook.com/${META_API_VERSION}/${cleanId}/campaigns?${new URLSearchParams({
            access_token: META_ACCESS_TOKEN,
            fields: "id,status",
            limit: "500"
          }).toString()}`
        )
      ]);

      const statusMap = new Map();
      if (campRes && Array.isArray(campRes.data)) {
        campRes.data.forEach((c) => {
          if (c && c.id) statusMap.set(String(c.id), String(c.status || "ACTIVE").toUpperCase());
        });
      }

      let hasSpendCap = false;
      let remainingUsd = null;
      let spendCapUsd = 0;
      let amountSpentUsd = 0;
      let balanceDueUsd = 0;

      if (accInfo && !accInfo.error) {
        const rawCap = Number(accInfo.spend_cap || 0);
        const rawSpent = Number(accInfo.amount_spent || 0);
        const rawBal = Number(accInfo.balance || 0);

        spendCapUsd = rawCap > 0 ? rawCap / 100 : 0;
        amountSpentUsd = rawSpent > 0 ? rawSpent / 100 : 0;
        balanceDueUsd = rawBal > 0 ? rawBal / 100 : 0;

        if (rawCap > 0) {
          hasSpendCap = true;
          remainingUsd = Math.max(0, (rawCap - rawSpent) / 100);
        }
      }

      let totalSpend = 0;
      let totalMessages = 0;
      let totalOrders = 0;
      let msgSpend = 0;
      let salesSpend = 0;
      const campaignList = [];

      rows.forEach((camp) => {
        const campSpend = parseFloat(camp.spend || 0);
        totalSpend += campSpend;

        let campMsgs = 0;
        let campOrders = 0;

        if (camp.actions) {
          const msgAction = camp.actions.find(
            (a) => a.action_type === "onsite_conversion.messaging_conversation_started_7d"
          );
          if (msgAction) campMsgs = parseInt(msgAction.value || 0, 10);

          const orderAction = camp.actions.find(
            (a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
          );
          if (orderAction) campOrders = parseInt(orderAction.value || 0, 10);
        }

        totalMessages += campMsgs;
        totalOrders += campOrders;

        const obj = (camp.objective || "").toUpperCase();
        const isMsgObj = obj.includes("MESSAGES") || obj.includes("ENGAGEMENT");
        const isSalesObj = obj.includes("OUTCOME_SALES") || obj.includes("CONVERSIONS");

        let cMsgSpend = 0;
        let cSalesSpend = 0;

        if (campMsgs > 0 && campOrders === 0) {
          cMsgSpend = campSpend;
        } else if (campOrders > 0 && campMsgs === 0) {
          cSalesSpend = campSpend;
        } else if (isMsgObj && !isSalesObj) {
          cMsgSpend = campSpend;
        } else if (isSalesObj && !isMsgObj) {
          cSalesSpend = campSpend;
        } else {
          if (campMsgs > 0) cMsgSpend = campSpend / 2;
          if (campOrders > 0) cSalesSpend = campSpend / 2;
        }

        msgSpend += cMsgSpend;
        salesSpend += cSalesSpend;

        const cCostPerMsg =
          campMsgs > 0 && cMsgSpend > 0 ? ((cMsgSpend / campMsgs) * 100).toFixed(1) : "0.0";
        const cCostPerOrder =
          campOrders > 0 && cSalesSpend > 0 ? (cSalesSpend / campOrders).toFixed(2) : "0.00";

        const campIdStr = String(camp.campaign_id || "");
        campaignList.push({
          id: campIdStr,
          name: camp.campaign_name || "Unnamed Ad Campaign",
          objective: camp.objective || "",
          status: statusMap.get(campIdStr) || "ACTIVE",
          spend: campSpend.toFixed(2),
          messages: campMsgs,
          msg_spend: cMsgSpend.toFixed(2),
          cost_per_msg_cents: cCostPerMsg,
          orders: campOrders,
          sales_spend: cSalesSpend.toFixed(2),
          cost_per_order_usd: cCostPerOrder
        });
      });

      campaignList.sort((a, b) => parseFloat(b.spend) - parseFloat(a.spend));

      let costPerMsgCents = "0.0";
      if (totalMessages > 0) {
        const costSpend = msgSpend > 0 ? msgSpend : totalOrders === 0 ? totalSpend : 0;
        if (costSpend > 0) costPerMsgCents = ((costSpend / totalMessages) * 100).toFixed(1);
      }

      let costPerOrderUsd = "0.00";
      if (totalOrders > 0) {
        const costSpend = salesSpend > 0 ? salesSpend : totalMessages === 0 ? totalSpend : 0;
        if (costSpend > 0) costPerOrderUsd = (costSpend / totalOrders).toFixed(2);
      }

      return {
        id: cleanId,
        name: acc.name,
        brand: acc.brand,
        spend: totalSpend.toFixed(2),
        has_spend_cap: hasSpendCap,
        remaining_usd: remainingUsd !== null ? remainingUsd.toFixed(2) : null,
        spend_cap_usd: spendCapUsd.toFixed(2),
        amount_spent_usd: amountSpentUsd.toFixed(2),
        balance_due_usd: balanceDueUsd.toFixed(2),
        messages: totalMessages,
        msg_spend: msgSpend.toFixed(2),
        cost_per_msg_cents: costPerMsgCents,
        orders: totalOrders,
        sales_spend: salesSpend.toFixed(2),
        cost_per_order_usd: costPerOrderUsd,
        campaigns: campaignList,
        error: error || null
      };
    } catch (err) {
      return {
        id: cleanId,
        name: acc.name,
        brand: acc.brand,
        spend: "0.00",
        has_spend_cap: false,
        remaining_usd: null,
        spend_cap_usd: "0.00",
        amount_spent_usd: "0.00",
        balance_due_usd: "0.00",
        messages: 0,
        msg_spend: "0.00",
        cost_per_msg_cents: "0.0",
        orders: 0,
        sales_spend: "0.00",
        cost_per_order_usd: "0.00",
        campaigns: [],
        error: err.message
      };
    }
  });

  const results = await Promise.all(promises);

  const sum = (key) => results.reduce((acc, cur) => acc + parseFloat(cur[key] || 0), 0);
  const totalSpendSum = sum("spend");
  const totalRemainingSum = results.reduce(
    (acc, cur) => acc + (cur.has_spend_cap && cur.remaining_usd !== null ? parseFloat(cur.remaining_usd) : 0),
    0
  );
  const hasAnyCap = results.some((r) => r.has_spend_cap && r.remaining_usd !== null);
  const totalMsgsSum = results.reduce((acc, cur) => acc + cur.messages, 0);
  const totalOrdersSum = results.reduce((acc, cur) => acc + cur.orders, 0);
  const totalMsgSpendSum = sum("msg_spend");
  const totalSalesSpendSum = sum("sales_spend");

  return {
    configured: true,
    has_error: results.some((r) => r.error),
    accounts: results,
    summary: {
      total_spend: totalSpendSum.toFixed(2),
      has_remaining_cap: hasAnyCap,
      total_remaining_usd: totalRemainingSum.toFixed(2),
      total_messages: totalMsgsSum,
      msg_spend: totalMsgSpendSum.toFixed(2),
      avg_cost_per_msg_cents:
        totalMsgsSum > 0 && totalMsgSpendSum > 0 ? ((totalMsgSpendSum / totalMsgsSum) * 100).toFixed(1) : "0.0",
      total_orders: totalOrdersSum,
      sales_spend: totalSalesSpendSum.toFixed(2),
      avg_cost_per_order_usd:
        totalOrdersSum > 0 && totalSalesSpendSum > 0 ? (totalSalesSpendSum / totalOrdersSum).toFixed(2) : "0.00"
    }
  };
}

const adsCache = new Map();
async function getAdsMetrics(date, brand) {
  const key = `${date}|${brand}`;
  const hit = adsCache.get(key);
  if (hit && Date.now() - hit.t < 60 * 1000) return hit.v;

  const v = await fetchMetaAdsMetrics(date, brand);
  if (!v.has_error) adsCache.set(key, { t: Date.now(), v });
  if (adsCache.size > 100) adsCache.clear();
  return v;
}

function postMetaCampaignStatus(campaignId, status) {
  return new Promise((resolve, reject) => {
    if (!META_ACCESS_TOKEN) return reject(new Error("META_ACCESS_TOKEN সেট করা নেই"));
    const body = new URLSearchParams({
      status: status,
      access_token: META_ACCESS_TOKEN
    }).toString();

    const options = {
      hostname: "graph.facebook.com",
      path: `/${META_API_VERSION}/${encodeURIComponent(campaignId)}`,
      method: "POST",
      agent: fbAgent,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) reject(new Error(parsed.error.message || "Meta API error"));
          else resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.setTimeout(10000, () => req.destroy(new Error("Meta API timeout")));
    req.write(body);
    req.end();
  });
}

app.post("/api/ads/toggle", requireAuth, async (req, res) => {
  try {
    const campaignId = String((req.body && req.body.campaign_id) || "").trim();
    const targetStatus = String((req.body && req.body.status) || "").toUpperCase();

    if (!campaignId || !["ACTIVE", "PAUSED"].includes(targetStatus)) {
      return res.status(400).json({ error: "Invalid campaign_id or status (ACTIVE / PAUSED)" });
    }

    await postMetaCampaignStatus(campaignId, targetStatus);
    adsCache.clear();
    detailCache.clear();
    res.json({ ok: true, campaign_id: campaignId, status: targetStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const detailCache = new Map();

function buildMetricRow(row, objective) {
  const spend = parseFloat((row && row.spend) || 0);
  const acts = (row && row.actions) || [];
  const m = acts.find((a) => a.action_type === "onsite_conversion.messaging_conversation_started_7d");
  const o = acts.find((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
  const msgs = m ? parseInt(m.value || 0, 10) : 0;
  const orders = o ? parseInt(o.value || 0, 10) : 0;
  const obj = String(objective || "").toUpperCase();
  const isMsgObj = obj.includes("MESSAGES") || obj.includes("ENGAGEMENT");
  const isSalesObj = obj.includes("OUTCOME_SALES") || obj.includes("CONVERSIONS");

  let msgSpend = 0;
  let salesSpend = 0;
  if (msgs > 0 && orders === 0) msgSpend = spend;
  else if (orders > 0 && msgs === 0) salesSpend = spend;
  else if (isMsgObj && !isSalesObj) msgSpend = spend;
  else if (isSalesObj && !isMsgObj) salesSpend = spend;
  else {
    if (msgs > 0) msgSpend = spend / 2;
    if (orders > 0) salesSpend = spend / 2;
  }

  return {
    spend: spend.toFixed(2),
    messages: msgs,
    msg_spend: msgSpend.toFixed(2),
    cost_per_msg_cents: msgs > 0 && msgSpend > 0 ? ((msgSpend / msgs) * 100).toFixed(1) : "0.0",
    orders,
    sales_spend: salesSpend.toFixed(2),
    cost_per_order_usd: orders > 0 && salesSpend > 0 ? (salesSpend / orders).toFixed(2) : "0.00"
  };
}

app.get("/api/ads/campaign-detail", requireAuth, async (req, res) => {
  try {
    if (!META_ACCESS_TOKEN) return res.status(400).json({ error: "META_ACCESS_TOKEN সেট করা নেই" });
    const campaignId = String(req.query.campaign_id || "").trim();
    const objective = String(req.query.objective || "");
    const rawDate = String(req.query.date || "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    if (!/^\d+$/.test(campaignId)) return res.status(400).json({ error: "Invalid campaign_id" });

    const key = `${campaignId}|${date}|${objective}`;
    const hit = detailCache.get(key);
    if (hit && Date.now() - hit.t < 30000) return res.json(hit.v);

    const base = `https://graph.facebook.com/${META_API_VERSION}/${campaignId}`;
    const insightUrl = (level, fields) =>
      `${base}/insights?${new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        level,
        fields,
        time_range: JSON.stringify({ since: date, until: date }),
        use_unified_attribution_setting: "true",
        limit: "500"
      })}`;
    const listUrl = (edge, fields) =>
      `${base}/${edge}?${new URLSearchParams({ access_token: META_ACCESS_TOKEN, fields, limit: "500" })}`;

    const [setIns, adIns, setList, adList] = await Promise.all([
      fetchAllInsights(insightUrl("adset", "adset_id,adset_name,spend,actions")),
      fetchAllInsights(insightUrl("ad", "ad_id,ad_name,adset_id,adset_name,spend,actions")),
      fetchPagedList(listUrl("adsets", "id,name,status")),
      fetchPagedList(listUrl("ads", "id,name,status,adset_id"))
    ]);

    const err = setIns.error || adIns.error || setList.error || adList.error;
    if (err) return res.status(502).json({ error: err });

    const sets = new Map();
    const touch = (id, name) => {
      if (!sets.has(id)) sets.set(id, { id, name: name || `Ad set ${id}`, status: "ACTIVE", row: null, ads: new Map() });
      return sets.get(id);
    };

    setList.rows.forEach((s) => {
      const x = touch(String(s.id), s.name);
      x.status = String(s.status || "ACTIVE").toUpperCase();
    });
    setIns.rows.forEach((r) => { touch(String(r.adset_id), r.adset_name).row = r; });
    adList.rows.forEach((a) => {
      if (!a.adset_id) return;
      touch(String(a.adset_id), "").ads.set(String(a.id), {
        id: String(a.id), name: a.name, status: String(a.status || "ACTIVE").toUpperCase(), row: null
      });
    });
    adIns.rows.forEach((r) => {
      const x = touch(String(r.adset_id), r.adset_name);
      const id = String(r.ad_id);
      const cur = x.ads.get(id) || { id, name: r.ad_name, status: "ACTIVE", row: null };
      cur.row = r;
      cur.name = cur.name || r.ad_name;
      x.ads.set(id, cur);
    });

    const bySpend = (a, b) => parseFloat(b.spend) - parseFloat(a.spend);
    const adsets = [];
    sets.forEach((s) => {
      const ads = Array.from(s.ads.values())
        .map((a) => ({ id: a.id, name: a.name || `Ad ${a.id}`, status: a.status, ...buildMetricRow(a.row, objective) }))
        .filter((a) => parseFloat(a.spend) > 0 || a.status === "ACTIVE")
        .sort(bySpend);
      const item = { id: s.id, name: s.name, status: s.status, ...buildMetricRow(s.row, objective), ads };
      if (parseFloat(item.spend) > 0 || item.status === "ACTIVE") adsets.push(item);
    });
    adsets.sort(bySpend);

    const v = { campaign_id: campaignId, date, adsets };
    detailCache.set(key, { t: Date.now(), v });
    if (detailCache.size > 200) detailCache.clear();
    res.json(v);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function querySeenNoReplyRows(targetDate, scope) {
  const pcM = pageClause(scope.ids, "m.page_id");
  const seenThresholdMs = Date.now() - SEEN_NO_REPLY_MS;

  return db
    .prepare(
      `WITH latest_msg AS (
         SELECT m.page_id, m.sender_id, MAX(m.id) AS last_id
         FROM messages m
         WHERE ${DAY_M} = ?${pcM.sql}
         GROUP BY m.page_id, m.sender_id
       )
       SELECT
         m.page_id,
         m.sender_id,
         m.message_text,
         m.message_time,
         m.read_time,
         c.name AS customer_name
       FROM latest_msg lm
       JOIN messages m ON m.id = lm.last_id
       LEFT JOIN customers c ON c.page_id = m.page_id AND c.sender_id = m.sender_id
       WHERE m.status = 'read'
         AND COALESCE(m.read_time, 0) > 0
         AND COALESCE(m.read_time, 0) <= ?
         AND NOT EXISTS (
           SELECT 1 FROM replies r
           WHERE r.page_id = m.page_id
             AND r.sender_id = m.sender_id
             AND COALESCE(r.reply_time, 0) > COALESCE(m.message_time, 0)
         )
       ORDER BY m.read_time ASC`
    )
    .all(targetDate, ...pcM.params, seenThresholdMs);
}

app.get("/api/seen-no-reply", requireAuth, async (req, res) => {
  try {
    const rawDate = String(req.query.date || "");
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    const scope = resolveScope(req.query.page_id || req.query.scope);

    const initialRows = querySeenNoReplyRows(targetDate, scope);
    const nowMs = Date.now();

    const toSync = initialRows
      .filter((r) => !r.customer_name || String(r.customer_name).startsWith("Customer_"))
      .slice(0, 15);
    if (toSync.length) {
      await Promise.all(
        toSync.map((m) => syncCustomerAndAdFromGraph(m.page_id, m.sender_id).catch(() => null))
      );
    }

    const rows = toSync.length ? querySeenNoReplyRows(targetDate, scope) : initialRows;

    const items = rows.map((r) => {
      const waitMin = r.read_time ? Math.max(0, Math.round((nowMs - Number(r.read_time)) / 60000)) : 0;
      const cleanName = r.customer_name && !String(r.customer_name).startsWith("Customer_")
        ? r.customer_name
        : "";
      return {
        page_id: r.page_id,
        page_name: PAGE_NAMES[r.page_id] || r.page_id,
        sender_id: r.sender_id,
        customer_name: cleanName || `Customer_${String(r.sender_id).slice(-4)}`,
        has_real_name: Boolean(cleanName),
        last_message: r.message_text || "",
        message_time: r.message_time || 0,
        read_time: r.read_time || 0,
        waiting_minutes: waitMin,
        business_suite_url: `https://business.facebook.com/latest/inbox/all?asset_id=${encodeURIComponent(r.page_id)}`
      };
    });

    res.json({
      date: targetDate,
      scope: { key: scope.key, label: scope.label },
      count: items.length,
      items
    });
  } catch (err) {
    console.error("seen-no-reply list error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/daily-report", requireAuth, async (req, res) => {
  try {
    const rawDate = String(req.query.date || "");
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    const scope = resolveScope(req.query.page_id || req.query.scope);
    const win = shiftWindow(targetDate, String(req.query.shift || "all"));

    const pc = pageClause(scope.ids);
    const pcM = pageClause(scope.ids, "m.page_id");
    const pcR = pageClause(scope.ids, "r.page_id");
    const pcA = pageClause(scope.ids, "a.page_id");

    const CUST = "page_id || ':' || sender_id";
    const CUST_M = "m.page_id || ':' || m.sender_id";
    const count = (sql, params) => db.prepare(sql).get(...params).count;

    const totalReceived = count(
      `SELECT COUNT(DISTINCT ${CUST}) AS count FROM messages WHERE ${DAY} = ?${pc.sql}`,
      [targetDate, ...pc.params]
    );

    const totalRawMessages = count(
      `SELECT COUNT(*) AS count FROM messages WHERE ${DAY} = ?${pc.sql}`,
      [targetDate, ...pc.params]
    );

    const returningCustomers = count(
      `SELECT COUNT(DISTINCT ${CUST_M}) AS count
       FROM messages m
       WHERE ${DAY_M} = ?${pcM.sql}
         AND EXISTS (
           SELECT 1 FROM messages p
           WHERE p.page_id = m.page_id AND p.sender_id = m.sender_id
             AND date(p.created_at, '+6 hours') < ?
         )`,
      [targetDate, ...pcM.params, targetDate]
    );

    const newCustomers = Math.max(0, totalReceived - returningCustomers);

    const totalReplied = count(
      `SELECT COUNT(DISTINCT ${CUST}) AS count FROM messages
       WHERE status = 'replied' AND ${DAY} = ?${pc.sql}`,
      [targetDate, ...pc.params]
    );

    const unreadPending = count(
      `SELECT COUNT(DISTINCT ${CUST}) AS count FROM messages
       WHERE status = 'unread' AND ${DAY} = ?${pc.sql}`,
      [targetDate, ...pc.params]
    );

    const seenRows = querySeenNoReplyRows(targetDate, scope);
    const readNoReply = seenRows.length;

    const dayReplyRowsForOrder = db
      .prepare(`SELECT page_id, sender_id, reply_text, is_order_confirm FROM replies WHERE ${DAY} = ?${pc.sql}`)
      .all(targetDate, ...pc.params);
    const confirmedCustSet = new Set();
    for (const r of dayReplyRowsForOrder) {
      if (r.is_order_confirm || isOrderConfirmText(r.reply_text)) {
        confirmedCustSet.add(`${r.page_id}:${r.sender_id}`);
      }
    }
    const orderConfirms = confirmedCustSet.size;

    const dayPhoneRows = db
      .prepare(`SELECT page_id, sender_id, message_text, phone_number FROM messages WHERE ${DAY} = ?${pc.sql}`)
      .all(targetDate, ...pc.params);
    const uniquePhones = new Set();
    for (const p of dayPhoneRows) {
      const ph = p.phone_number || extractPhoneNumber(p.message_text);
      if (ph) uniquePhones.add(ph);
    }
    const phoneCount = uniquePhones.size;

    const isShift = win.key !== "all";
    const inShift = (t) => !isShift || (t >= win.startMs && t < win.endMs);

    const mergedByMod = new Map();
    const ensureMod = (rawMod) => {
      const modName = normalizeModeratorName(rawMod);
      if (!modName || modName === "Unassigned") return null;
      if (!mergedByMod.has(modName)) {
        mergedByMod.set(modName, {
          name: modName,
          total_conversations: 0,
          total_messages: 0,
          confirmed_orders: 0,
          phone_numbers: 0
        });
      }
      return mergedByMod.get(modName);
    };

    const firstByCustomer = new Map();
    let unattributedMessages = 0;

    // 1. moderator_assignments থেকে হিসাব (রিপ্লাই ডাটাবেসে সেভ না করলেও মডারেটর ট্র্যাক থাকে)
    const dayAssignments = db
      .prepare(
        `SELECT a.page_id, a.sender_id, a.moderator, a.assigned_at,
                COALESCE(a.msg_count, 0) AS msg_count,
                COALESCE(a.order_count, 0) AS order_count
         FROM moderator_assignments a
         WHERE a.day = ?${pcA.sql}
         ORDER BY COALESCE(a.assigned_at, 0) ASC`
      )
      .all(targetDate, ...pcA.params);

    for (const a of dayAssignments) {
      const t = Number(a.assigned_at) || Date.now();
      const cur = ensureMod(a.moderator);
      if (!cur) {
        if (inShift(t)) unattributedMessages += Math.max(1, Number(a.msg_count) || 1);
        continue;
      }
      const custKey = `${a.page_id}:${a.sender_id}`;
      if (!firstByCustomer.has(custKey)) {
        firstByCustomer.set(custKey, { mod: cur.name, time: t });
      }
      if (inShift(t)) {
        cur.total_messages += Math.max(1, Number(a.msg_count) || 0);
        cur.confirmed_orders += Number(a.order_count) || 0;
      }
    }

    // 2. পুরোনো replies রেকর্ড থাকলে সেগুলোও মেলানো
    const dayReplies = db
      .prepare(
        `SELECT r.page_id, r.sender_id, r.moderator, r.reply_time, r.created_at, r.is_order_confirm, r.reply_text
         FROM replies r
         WHERE ${DAY_R} = ?${pcR.sql}
         ORDER BY COALESCE(r.reply_time, 0) ASC, r.id ASC`
      )
      .all(targetDate, ...pcR.params);

    const seenAssignedKeys = new Set(dayAssignments.map((x) => `${x.page_id}:${x.sender_id}`));
    for (const r of dayReplies) {
      const custKey = `${r.page_id}:${r.sender_id}`;
      if (seenAssignedKeys.has(custKey)) continue;
      const t = Number(r.reply_time) > 0 ? Number(r.reply_time) : Date.parse(String(r.created_at).replace(" ", "T") + "Z") || 0;
      const cur = ensureMod(r.moderator);
      if (!cur) {
        if (inShift(t)) unattributedMessages += 1;
        continue;
      }
      if (!firstByCustomer.has(custKey)) {
        firstByCustomer.set(custKey, { mod: cur.name, time: t });
      }
      if (inShift(t)) {
        cur.total_messages += 1;
        if (r.is_order_confirm || isOrderConfirmText(r.reply_text)) cur.confirmed_orders += 1;
      }
    }

    for (const info of firstByCustomer.values()) {
      if (inShift(info.time)) {
        const cur = ensureMod(info.mod);
        if (cur) cur.total_conversations += 1;
      }
    }

    const phoneSetByMod = new Map();
    for (const p of dayPhoneRows) {
      const ph = p.phone_number || extractPhoneNumber(p.message_text);
      if (!ph) continue;
      const first = firstByCustomer.get(`${p.page_id}:${p.sender_id}`);
      if (!first || !inShift(first.time)) continue;
      if (!phoneSetByMod.has(first.mod)) phoneSetByMod.set(first.mod, new Set());
      phoneSetByMod.get(first.mod).add(ph);
    }
    for (const [modName, set] of phoneSetByMod.entries()) {
      const cur = ensureMod(modName);
      if (cur) cur.phone_numbers += set.size;
    }

    const board = Array.from(mergedByMod.values());
    board.sort(
      (a, b) =>
        b.total_conversations - a.total_conversations ||
        b.total_messages - a.total_messages ||
        b.phone_numbers - a.phone_numbers ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );

    const moderatorStats = board.map((m) => ({
      name: m.name,
      total_conversations: m.total_conversations,
      total_messages: m.total_messages,
      confirmed_orders: m.confirmed_orders,
      phone_numbers: m.phone_numbers,
      msgs_per_customer: m.total_conversations
        ? Math.round((m.total_messages / m.total_conversations) * 10) / 10
        : 0,
      avg_minutes_per_message:
        win.elapsed_minutes && m.total_messages
          ? Math.round((win.elapsed_minutes / m.total_messages) * 10) / 10
          : null
    }));

    const adsData = await getAdsMetrics(targetDate, scope.key);

    res.json({
      date: targetDate,
      generated_at: Date.now(),
      scope: { key: scope.key, label: scope.label },
      shift: {
        key: win.key,
        label: win.label,
        minutes: win.minutes,
        elapsed_minutes: win.elapsed_minutes
      },
      page_id: req.query.page_id || "all",
      page_name: scope.label,
      stats: {
        total_received: totalReceived,
        total_raw_messages: totalRawMessages,
        returning_customers: returningCustomers,
        new_customers: newCustomers,
        total_replied: totalReplied,
        unread_pending: unreadPending,
        read_without_reply: readNoReply,
        total_confirmed_orders: orderConfirms,
        total_phone_numbers: phoneCount,
        unattributed_messages: unattributedMessages
      },
      moderators: moderatorStats,
      ads: adsData
    });
  } catch (err) {
    console.error("daily-report error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/privacy-policy", (req, res) => {
  res.send(`<h1>Privacy Policy</h1><p>Analytics application for connected Facebook pages.</p>`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
