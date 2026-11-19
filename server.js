"use strict";

const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
require("dotenv").config();

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
  { name: "mony", fb_link: "https://www.facebook.com/profile.php?id=61594030833722", aliases: ["mony", "61594030833722"] },
  { name: "shuvro", fb_link: "https://www.facebook.com/profile.php?id=61594801244167", aliases: ["shuvro", "শুভ্র", "61594801244167"] },
  { name: "shihab", fb_link: "https://www.facebook.com/share/19iBuYADbj/?mibextid=wwXIfr", aliases: ["shihab", "19iBuYADbj"] },
  { name: "Faria", fb_link: "https://www.facebook.com/faria.rahman.800321", aliases: ["Faria", "faria", "faria.rahman.800321"] },
  { name: "Sanjana", fb_link: "https://www.facebook.com/share/1PHGk91SEz/", aliases: ["Sanjana", "sanjana", "সানজানা", "1PHGk91SEz"] },
  { name: "ashraful", fb_link: "https://www.facebook.com/profile.php?id=61592130331098&sk=about", aliases: ["ashraful", "আশরাফুল", "61592130331098"] },
  { name: "tania", fb_link: "https://www.facebook.com/profile.php?id=61591664456446", aliases: ["tania", "তানিয়া", "61591664456446"] },
  { name: "eram", fb_link: "https://www.facebook.com/share/1CRG2mozpQ/", aliases: ["eram", "ইরাম", "1CRG2mozpQ"] },
  { name: "fahim", fb_link: "https://www.facebook.com/ferdous.fahim.921", aliases: ["fahim", "ফাহিম", "ferdous.fahim.921"] },
  { name: "jaber", fb_link: "https://www.facebook.com/share/19kYfdY2fr/", aliases: ["jaber", "জাবের", "19kYfdY2fr"] },
  { name: "apon", fb_link: "https://www.facebook.com/profile.php?id=61593951013042&mibextid=ZbWKwL", aliases: ["apon", "আপন", "61593951013042"] },
  { name: "rifat", fb_link: "https://www.facebook.com/profile.php?id=61594203401850", aliases: ["rifat", "রিফাত", "Muhammad Rifat Molla", "61594203401850"] },
  { name: "halim", fb_link: "https://www.facebook.com/profile.php?id=61594028540149", aliases: ["halim", "হালিম", "61594028540149"] },
  { name: "farjana", fb_link: "https://www.facebook.com/share/1PoAchCNQh/", aliases: ["farjana", "ফারজানা", "1PoAchCNQh"] },
  { name: "apurbo", fb_link: "https://www.facebook.com/profile.php?id=61592804760356", aliases: ["apurbo", "অপুর্ব", "অপূর্ব", "61592804760356"] },
  { name: "ruman", fb_link: "https://www.facebook.com/ruman.hossen.342329", aliases: ["ruman", "রুমান", "Ruman Hossen", "ruman.hossen.342329"] },
  { name: "saidul", fb_link: "https://www.facebook.com/profile.php?id=61592488485671", aliases: ["saidul", "সাইদুল", "61592488485671"] },
  { name: "samir", fb_link: "https://www.facebook.com/share/r/1DWP6xPJpU/?mibextid=wwXIfr", aliases: ["samir", "সামির", "1DWP6xPJpU"] }
];

function extractFbIdentifier(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s.length > 140) return null;

  const idQuery = s.match(/[?&]id=(\d{5,})/i);
  if (idQuery) return idQuery[1];

  // share/XXXX  অথবা  share/r/XXXX  (reel/post share link)
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

const BN_RANGE = "\\u0980-\\u09FF";
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "আমি mony" / "ami mony" / "I am mony" — welcome message থেকে moderator চেনা
const MODERATOR_WELCOME_RULES = MODERATORS.map((m) => {
  const names = [m.name, ...(m.aliases || [])].filter((t) => t && !/^\d+$/.test(String(t).trim()));
  const alt = names
    .map((a) => String(a).normalize("NFC").trim().split(/\s+/).map(escapeRegex).join("\\s+"))
    .join("|");
  return {
    name: m.name,
    re: alt
      ? new RegExp(`(?<![\\w${BN_RANGE}])(?:আমি|ami|I\\s*am|I'm)\\s+(?:${alt})(?![\\w${BN_RANGE}])`, "i")
      : null
  };
});

function detectModeratorFromWelcomeText(text) {
  if (!text) return null;
  const clean = String(text).normalize("NFC");
  for (const rule of MODERATOR_WELCOME_RULES) {
    if (rule.re && rule.re.test(clean)) {
      return rule.name;
    }
  }
  return null;
}

function normalizeModeratorName(rawMod) {
  if (!rawMod) return null;
  const trimmed = String(rawMod).trim();
  if (!trimmed) return null;
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
try { db.exec(`ALTER TABLE saved_replies ADD COLUMN page_group TEXT DEFAULT 'all';`); } catch (e) {}
try { db.exec(`UPDATE saved_replies SET page_group = 'all' WHERE page_group IS NULL OR page_group = '';`); } catch (e) {}

// আগের ভুল "Customer Sent Product Photo" ad তথ্য মুছে ফেলা (কাস্টমারের পাঠানো ছবি ad ছিল না)
try { db.exec(`UPDATE customers SET ad_info = NULL WHERE ad_info LIKE '%Customer Sent Product Photo%'`); } catch (e) {}

// DB-তে সেভ করা extra moderator alias (Meta-র আসল ID ম্যাপ করার জন্য)
function loadDbAliases() {
  try {
    for (const r of db.prepare(`SELECT alias, moderator FROM mod_aliases`).all()) {
      registerAlias(r.alias, r.moderator);
    }
  } catch (e) {}
}
loadDbAliases();

// Customer chat read/unread track korar jonno
db.exec(`
  CREATE TABLE IF NOT EXISTS mod_reads (
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, sender_id)
  );
`);

try { db.prepare(`DELETE FROM echo_log WHERE created_ms < ?`).run(Date.now() - 7 * 24 * 3600 * 1000); } catch (e) {}

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
    SET status = 'read', read_time = ?
    WHERE page_id = ? AND sender_id = ? AND message_time <= ? AND status = 'unread'
  `),
  insertReply: db.prepare(`
    INSERT INTO replies
    (page_id, sender_id, message_id, reply_text, image_url, reply_time, moderator, is_order_confirm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  assignModerator: db.prepare(`
    INSERT OR IGNORE INTO moderator_assignments (page_id, sender_id, day, moderator, assigned_at, bucket)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `),
  markReplied: db.prepare(`
    UPDATE messages
    SET status = 'replied'
    WHERE page_id = ? AND sender_id = ? AND status != 'replied'
      AND ${DAY} = ?
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
  const match = text.match(/(?:\+?88)?01[3-9]\d{8}\b/);
  return match ? match[0] : null;
}

const fbAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

function sendFacebookPayload(pageId, bodyObj) {
  return new Promise((resolve, reject) => {
    const token = getPageToken(pageId);
    if (!token) {
      return reject(new Error(`Page ID (${pageId}) এর জন্য Railway Variables-এ SWAPONS_WORLD_PAGE_TOKEN বা STONE_ROSE_PAGE_TOKEN সেট করা নেই!`));
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

function parseAdJson(raw) {
  if (!raw) return null;
  try {
    const tmp = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (tmp && !isBlockedStickerUrl(tmp.photo_url) && !isBlockedStickerUrl(tmp.post_url)) return tmp;
  } catch (e) {}
  return null;
}

/* ------------------------------------------------------------------ */
/* Ad enrich: ad_id থেকে Meta Graph দিয়ে ভিডিও / ছবি / পোস্ট লিংক আনা  */
/* ------------------------------------------------------------------ */
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

// ব্রাউজারের URL থেকে সরাসরি debug দেখার জন্য: ?key=DASHBOARD_PASS (বা MOD_PASS)
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

/* ------------------------------------------------------------------ */
/* Ad referral (Click-to-Messenger ad থেকে আসা কাস্টমার)               */
/* ------------------------------------------------------------------ */
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

/**
 * Page থেকে যাওয়া reply (echo) কে কোন moderator পাঠিয়েছে সেটা বের করে।
 * ক্রম: (১) welcome text "আমি mony"  (২) echo-র from  (৩) Graph message from
 *       (৪) conversation থেকে  (৫) ওই কাস্টমারের আজকের assigned moderator
 */
async function resolveEchoModerator(pageId, customerId, event) {
  const info = { mod: null, via: "", fromId: "", fromName: "" };
  const replyText = String((event.message && event.message.text) || "").trim();

  const welcomeName = detectModeratorFromWelcomeText(replyText);
  if (welcomeName) {
    info.mod = welcomeName;
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
    if (byId) { info.mod = byId; info.via = via + ":id"; return true; }
    if (from.name) {
      const byName = detectModeratorByFbLink(from.name) || detectModeratorFromWelcomeText(from.name);
      if (byName) { info.mod = byName; info.via = via + ":name"; return true; }
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

  // শেষ ভরসা: ওই কাস্টমার আজ যে moderator-এর কাছে assigned
  try {
    const row = db
      .prepare(`SELECT moderator FROM moderator_assignments WHERE page_id = ? AND sender_id = ? AND day = ?`)
      .get(pageId, customerId, dhakaDate(event.timestamp || Date.now()));
    if (row && row.moderator) {
      info.mod = row.moderator;
      info.via = "assignment_fallback";
    }
  } catch (e) {}

  return info;
}

async function handleMessagingEvent(pageId, event) {
  const today = dhakaDate();
  const senderId = event.sender && event.sender.id;
  const adInfoJson = extractAdReferral(event);

  if (adInfoJson && senderId && (!event.message || !event.message.is_echo)) {
    db.prepare(`
      INSERT INTO customers (page_id, sender_id, ad_info) VALUES (?, ?, ?)
      ON CONFLICT(page_id, sender_id) DO UPDATE SET ad_info = excluded.ad_info
    `).run(pageId, senderId, adInfoJson);

    // ad_id থেকে ভিডিও/ছবি/পোস্ট লিংক আনা (ব্যাকগ্রাউন্ডে)
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

    stmts.insertMessage.run(
      pageId,
      senderId,
      event.message.mid,
      displayText,
      imageUrl,
      adInfoJson,
      event.timestamp,
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
    let replyImg = null;
    if (event.message.attachments && event.message.attachments.length > 0) {
      const att = event.message.attachments[0];
      if (att.payload && att.payload.url && !isBlockedStickerUrl(att.payload.url)) {
        replyImg = att.payload.url;
      }
    }

    const replyTime = event.timestamp || Date.now();
    const replyDay = dhakaDate(replyTime);

    // এই dashboard থেকে পাঠানো মেসেজের echo আবার গুনলে double count হয় — স্কিপ
    let sentFromDashboard = null;
    if (replyText) {
      sentFromDashboard = db
        .prepare(`SELECT id FROM replies WHERE page_id = ? AND sender_id = ? AND message_id LIKE 'mod_%' AND reply_text = ? AND ABS(COALESCE(reply_time, 0) - ?) <= 30000`)
        .get(pageId, customerId, replyText, replyTime);
    } else if (replyImg) {
      sentFromDashboard = db
        .prepare(`SELECT id FROM replies WHERE page_id = ? AND sender_id = ? AND message_id LIKE 'mod_%' AND image_url IS NOT NULL AND ABS(COALESCE(reply_time, 0) - ?) <= 30000`)
        .get(pageId, customerId, replyTime);
    }
    if (sentFromDashboard) return;

    const isConfirm = replyText.toLowerCase().includes("your order confirm") ? 1 : 0;
    const resolved = await resolveEchoModerator(pageId, customerId, event);
    const mod = resolved.mod;

    const exists = db.prepare(`SELECT id FROM replies WHERE message_id = ?`).get(event.message.mid);
    if (!exists) {
      stmts.insertReply.run(pageId, customerId, event.message.mid, replyText || (replyImg ? "[ছবি]" : "👍"), replyImg, replyTime, mod, isConfirm);

      try {
        db.prepare(`
          INSERT INTO echo_log (page_id, customer_id, mid, text, from_id, from_name, app_id, via, moderator, created_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pageId,
          String(customerId),
          event.message.mid || "",
          String(replyText).slice(0, 80),
          resolved.fromId,
          resolved.fromName,
          String(event.message.app_id || ""),
          resolved.via || "unresolved",
          mod || "",
          Date.now()
        );
      } catch (e) {}
    }

    if (mod) stmts.assignModerator.run(pageId, customerId, replyDay, mod, replyTime);
    stmts.markReplied.run(pageId, customerId, replyDay);
    return;
  }

  if (event.read) {
    stmts.markRead.run(Date.now(), pageId, senderId, event.read.watermark);
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

/* ------------------------------------------------------------------ */
/* Debug: Meta আসলে কী referral পাঠাচ্ছে                               */
/* ------------------------------------------------------------------ */
// /api/referral-log?key=YOUR_PASS
app.get("/api/referral-log", requireDebugAuth, (req, res) => {
  res.json({ count: referralLog.length, rows: referralLog });
});

/* ------------------------------------------------------------------ */
/* Moderator ID debug / mapping                                        */
/* ------------------------------------------------------------------ */
// দেখুন Meta আসলে কোন ID/নাম পাঠাচ্ছে: /api/echo-log?key=YOUR_PASS
app.get("/api/echo-log", requireDebugAuth, (req, res) => {
  const rows = db
    .prepare(`SELECT page_id, customer_id, text, from_id, from_name, app_id, via, moderator, created_ms FROM echo_log ORDER BY id DESC LIMIT 150`)
    .all();
  res.json({ count: rows.length, rows });
});

// ID ম্যাপ করুন: /api/mod-alias?key=PASS&alias=<from_id>&moderator=mony
app.get("/api/mod-alias", requireDebugAuth, (req, res) => {
  const alias = String(req.query.alias || "").trim();
  const modName = normalizeModeratorName(String(req.query.moderator || ""));
  const known = MODERATORS.find((m) => m.name === modName);
  if (!alias || !known) {
    return res.status(400).json({ error: "alias আর সঠিক moderator নাম দিন", moderators: MODERATORS.map((m) => m.name) });
  }
  db.prepare(`INSERT INTO mod_aliases (alias, moderator) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET moderator = excluded.moderator`).run(alias, known.name);
  registerAlias(alias, known.name);
  const upd = db
    .prepare(`UPDATE replies SET moderator = ? WHERE message_id IN (SELECT mid FROM echo_log WHERE from_id = ?)`)
    .run(known.name, alias);
  res.json({ ok: true, alias, moderator: known.name, old_replies_fixed: upd.changes });
});

/* ------------------------------------------------------------------ */
/* Shared Saved Replies (Page-wise + Meta Sync)                        */
/* ------------------------------------------------------------------ */
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

app.get("/api/saved-replies", requireModAuth, (req, res) => {
  res.json({ replies: listSavedRepliesFor(req.query.page_id) });
});

app.post("/api/saved-replies", requireModAuth, (req, res) => {
  const body = req.body || {};
  const id = String(body.id || `sr_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`).trim();
  const title = String(body.title || "quick").trim() || "quick";
  const text = String(body.text || "").trim();
  const createdBy = String(body.created_by || "moderator").trim();
  const group = groupOf(body.page_id || body.page_group) || "all";
  const now = Date.now();

  if (!text && !title) {
    return res.status(400).json({ error: "Title or reply text required" });
  }

  stmts.upsertSavedReply.run(id, title, text, "shared", createdBy, now, group);
  res.json({
    ok: true,
    reply: { id, title, text, source: "shared", created_by: createdBy, updated_at: now, page_group: group }
  });
});

app.delete("/api/saved-replies/:id", requireModAuth, (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "Invalid ID" });
  stmts.deleteSavedReply.run(id);
  res.json({ ok: true, id });
});

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

async function syncMetaSavedRepliesNow() {
  let imported = 0;
  const errors = [];

  const tokenEntries = Object.entries(PAGE_TOKENS).filter(([, t]) => Boolean(t));
  if (!tokenEntries.length && META_ACCESS_TOKEN) {
    const pagesRes = await httpsGetJson(
      `https://graph.facebook.com/${META_API_VERSION}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`
    );
    if (pagesRes && Array.isArray(pagesRes.data)) {
      for (const p of pagesRes.data) {
        if (p && p.id && p.access_token) tokenEntries.push([String(p.id), String(p.access_token)]);
      }
    }
  }

  const fetchedByGroup = new Map();
  const failedGroups = new Set();

  for (const [pageId, token] of tokenEntries) {
    const group = PAGE_TO_GROUP[pageId] || "all";
    const edges = ["saved_message_responses", "saved_replies"];
    let result = null;
    let lastErr = null;

    for (const edge of edges) {
      const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(pageId)}/${edge}?fields=id,title,message&limit=100&access_token=${encodeURIComponent(token)}`;
      const r = await fetchPagedList(url);
      if (!r.error) { result = r; break; }
      lastErr = r.error;
    }

    if (!result) {
      failedGroups.add(group);
      errors.push(`${PAGE_NAMES[pageId] || pageId}: ${lastErr}`);
      continue;
    }

    if (!fetchedByGroup.has(group)) fetchedByGroup.set(group, new Set());
    const now = Date.now();

    for (const item of result.rows) {
      const msgTxt = String(item.message || "").trim();
      if (!msgTxt) continue;
      const title = String(item.title || "").trim() || msgTxt.slice(0, 20);
      // দুই Swapons page-এ একই reply থাকলে একবারই সেভ হবে
      const hash = crypto.createHash("sha1").update(`${title}|${msgTxt}`).digest("hex").slice(0, 12);
      const srId = `meta_${group}_${hash}`;
      stmts.upsertSavedReply.run(srId, title, msgTxt, "meta", PAGE_NAMES[pageId] || pageId, now, group);
      fetchedByGroup.get(group).add(srId);
      imported += 1;
    }
  }

  // Meta থেকে ডিলিট হওয়া reply এখানেও মুছে ফেলা (শুধু সফলভাবে sync হওয়া group-এর জন্য)
  for (const [group, idSet] of fetchedByGroup.entries()) {
    if (failedGroups.has(group)) continue;
    const existing = db
      .prepare(`SELECT id FROM saved_replies WHERE source = 'meta' AND page_group = ?`)
      .all(group);
    for (const row of existing) {
      if (!idSet.has(row.id)) stmts.deleteSavedReply.run(row.id);
    }
  }

  return { imported, errors };
}

app.post("/api/saved-replies/sync-meta", requireModAuth, async (req, res) => {
  try {
    const { imported, errors } = await syncMetaSavedRepliesNow();
    const pageRef = (req.body && req.body.page_id) || req.query.page_id;
    res.json({ ok: true, imported, errors, replies: listSavedRepliesFor(pageRef) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// সার্ভার নিজে থেকেই প্রতি ১০ মিনিটে Meta page-এর saved reply টেনে আনবে
setTimeout(() => { syncMetaSavedRepliesNow().catch(() => {}); }, 8000);
setInterval(() => { syncMetaSavedRepliesNow().catch(() => {}); }, 10 * 60 * 1000).unref();

app.get("/api/mod/list", (req, res) => {
  res.json({ moderators: MODERATORS.map((m) => m.name) });
});

function sentMessagesByModerator(day, ids) {
  const pcR = pageClause(ids, "r.page_id");
  const rows = db
    .prepare(
      `SELECT r.moderator, COUNT(*) AS msgs, COUNT(DISTINCT r.page_id || ':' || r.sender_id) AS custs
       FROM replies r
       WHERE ${DAY_R} = ?${pcR.sql}
         AND r.moderator IS NOT NULL AND r.moderator != ''
       GROUP BY r.moderator`
    )
    .all(day, ...pcR.params);

  const map = new Map();
  for (const r of rows) {
    const name = normalizeModeratorName(r.moderator);
    if (!name) continue;
    const cur = map.get(name) || { msgs: 0, custs: 0 };
    cur.msgs += r.msgs;
    cur.custs += r.custs;
    map.set(name, cur);
  }
  return map;
}

app.post("/api/mod/batch", requireModAuth, async (req, res) => {
  try {
    const { moderator, requestNew, pageFilter, bucket, date } = req.body;
    if (!moderator) return res.status(400).json({ error: "Moderator name required" });

    const todayStr = dhakaDate();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : todayStr;
    const isToday = day === todayStr;

    const activeBucket = BUCKETS.includes(bucket) ? bucket : "pending";
    const scope = resolveScope(pageFilter || "all");
    const pcM = pageClause(scope.ids, "m.page_id");
    const pcA = pageClause(scope.ids, "a.page_id");

    const getBucketCustomers = (targetBucket) => {
      const orderSql =
        targetBucket === "pending" ? "MIN(m.id) ASC" : "(unread_count > 0) DESC, last_time DESC";
      return db.prepare(`
        SELECT 
          m.page_id,
          m.sender_id,
          COALESCE(NULLIF(MAX(c.name), ''), 'Customer_' || substr(m.sender_id, -4)) as customer_name,
          MAX(c.profile_pic) as profile_pic,
          COALESCE(MAX(c.ad_info), MAX(m.ad_info)) as ad_info,
          (SELECT lm.message_text FROM messages lm
             WHERE lm.page_id = m.page_id AND lm.sender_id = m.sender_id
             ORDER BY COALESCE(lm.message_time, 0) DESC, lm.id DESC LIMIT 1) as last_message,
          MAX(m.message_time) as last_time,
          COUNT(m.id) as msg_count,
          (SELECT COUNT(*) FROM messages um
             WHERE um.page_id = m.page_id AND um.sender_id = m.sender_id
               AND COALESCE(um.message_time, 0) > COALESCE(
                 (SELECT rd.read_at FROM mod_reads rd WHERE rd.page_id = m.page_id AND rd.sender_id = m.sender_id), 0)
          ) as unread_count
        FROM messages m
        JOIN moderator_assignments a 
          ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
        LEFT JOIN customers c ON m.page_id = c.page_id AND m.sender_id = c.sender_id
        WHERE a.moderator = ?
          AND COALESCE(NULLIF(a.bucket, ''), 'pending') = ?
          AND ${DAY_M} = ?
          ${pcM.sql}
        GROUP BY m.page_id, m.sender_id
        ORDER BY ${orderSql}
      `).all(day, moderator, targetBucket, day, ...pcM.params);
    };

    // শুধু আজকের দিনে নতুন কাস্টমার assign হবে; পুরনো দিন শুধু দেখার জন্য
    if (isToday && (activeBucket === "pending" || requestNew)) {
      // সব পেজ মিলিয়ে এই moderator-এর মোট pending কত
      const pcPend = pageClause(scope.ids, "a.page_id");
      const totalPending = db.prepare(`
        SELECT COUNT(DISTINCT a.page_id || ':' || a.sender_id) AS cnt
        FROM moderator_assignments a
        JOIN messages m ON m.page_id = a.page_id AND m.sender_id = a.sender_id AND ${DAY_M} = ?
        WHERE a.day = ? AND a.moderator = ?
          AND COALESCE(NULLIF(a.bucket, ''), 'pending') = 'pending'
          ${pcPend.sql}
      `).get(todayStr, todayStr, moderator, ...pcPend.params).cnt;

      const slotsNeeded = 10 - totalPending;
      if (slotsNeeded > 0) {
        const unassignedCustomers = db.prepare(`
          SELECT DISTINCT m.page_id, m.sender_id
          FROM messages m
          LEFT JOIN moderator_assignments a 
            ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
          WHERE a.moderator IS NULL
            AND m.status != 'replied'
            AND ${DAY_M} = ?
            ${pcM.sql}
          ORDER BY m.id ASC
          LIMIT ?
        `).all(todayStr, todayStr, ...pcM.params, slotsNeeded);

        const assignTransaction = db.transaction((list) => {
          const now = Date.now();
          for (const item of list) {
            stmts.assignModerator.run(item.page_id, item.sender_id, todayStr, moderator, now);
          }
        });
        assignTransaction(unassignedCustomers);
      }
    }

    const currentList = getBucketCustomers(activeBucket);

    const missingProfiles = currentList.filter(
      (q) => !q.profile_pic || q.customer_name.startsWith("Customer_")
    );
    if (missingProfiles.length > 0) {
      Promise.all(
        missingProfiles.slice(0, 5).map((q) => syncCustomerAndAdFromGraph(q.page_id, q.sender_id))
      ).catch(() => {});
    }

    // প্রতিটি bucket-এর কাস্টমার সংখ্যা + unread (নতুন মেসেজ) সংখ্যা
    const bucketRows = db.prepare(`
      SELECT b,
             COUNT(*) AS cust,
             SUM(CASE WHEN u > 0 THEN 1 ELSE 0 END) AS ucust,
             SUM(u) AS umsgs
      FROM (
        SELECT COALESCE(NULLIF(a.bucket, ''), 'pending') AS b,
               a.page_id, a.sender_id,
               (SELECT COUNT(*) FROM messages um
                  WHERE um.page_id = a.page_id AND um.sender_id = a.sender_id
                    AND COALESCE(um.message_time, 0) > COALESCE(
                      (SELECT rd.read_at FROM mod_reads rd WHERE rd.page_id = a.page_id AND rd.sender_id = a.sender_id), 0)
               ) AS u
        FROM moderator_assignments a
        WHERE a.day = ? AND a.moderator = ? ${pcA.sql}
          AND EXISTS (
            SELECT 1 FROM messages m
            WHERE m.page_id = a.page_id AND m.sender_id = a.sender_id AND ${DAY_M} = ?
          )
      )
      GROUP BY b
    `).all(day, moderator, ...pcA.params, day);

    const counts = {};
    const unread = {};
    BUCKETS.forEach((b) => { counts[b] = 0; unread[b] = { customers: 0, messages: 0 }; });
    bucketRows.forEach((r) => {
      if (counts[r.b] === undefined) return;
      counts[r.b] = r.cust;
      if (isToday) {
        unread[r.b] = { customers: r.ucust || 0, messages: r.umsgs || 0 };
      }
    });

    const assignedTotal = BUCKETS.reduce((s, b) => s + counts[b], 0);
    const sentMap = sentMessagesByModerator(day, scope.ids);
    const myName = normalizeModeratorName(moderator) || moderator;
    const sentMessages = (sentMap.get(myName) || { msgs: 0 }).msgs;

    const globalUnassigned = db.prepare(`
      SELECT COUNT(DISTINCT m.page_id || ':' || m.sender_id) as count
      FROM messages m
      LEFT JOIN moderator_assignments a 
        ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
      WHERE a.moderator IS NULL
        AND m.status != 'replied'
        AND ${DAY_M} = ?
        ${pcM.sql}
    `).get(todayStr, todayStr, ...pcM.params).count;

    res.json({
      moderator,
      day,
      is_today: isToday,
      bucket: activeBucket,
      counts,
      unread,
      assigned_total: assignedTotal,
      sent_messages: sentMessages,
      queue: currentList.map((q) => ({
        ...q,
        unread_count: isToday ? q.unread_count : 0,
        ad_data: parseAdJson(q.ad_info),
        page_name: PAGE_NAMES[q.page_id] || "Page"
      })),
      global_unassigned: globalUnassigned
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mod/classify", requireModAuth, (req, res) => {
  try {
    const { page_id, sender_id, moderator, bucket } = req.body;
    if (!page_id || !sender_id || !moderator || !BUCKETS.includes(bucket)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const today = dhakaDate();
    const now = Date.now();

    db.prepare(`
      INSERT INTO moderator_assignments (page_id, sender_id, day, moderator, assigned_at, bucket)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(page_id, sender_id, day) DO UPDATE SET moderator = excluded.moderator, bucket = excluded.bucket
    `).run(page_id, sender_id, today, moderator, now, bucket);

    res.json({ success: true, bucket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/mod/chat", requireModAuth, async (req, res) => {
  try {
    const { page_id, sender_id } = req.query;

    const incoming = db.prepare(`
      SELECT 'customer' as sender, COALESCE(NULLIF(message_text, ''), '👍') as text, image_url, ad_info, message_time as time
      FROM messages
      WHERE page_id = ? AND sender_id = ?
    `).all(page_id, sender_id);

    const outgoing = db.prepare(`
      SELECT 'page' as sender, COALESCE(NULLIF(reply_text, ''), '👍') as text, image_url, reply_time as time, moderator
      FROM replies
      WHERE page_id = ? AND sender_id = ?
    `).all(page_id, sender_id);

    let custRow = db.prepare(`SELECT name, profile_pic, ad_info FROM customers WHERE page_id = ? AND sender_id = ?`).get(page_id, sender_id);

    let adData = parseAdJson(custRow && custRow.ad_info);
    if (!adData) {
      const withAd = incoming.filter((i) => i.ad_info).map((i) => parseAdJson(i.ad_info)).filter(Boolean);
      if (withAd.length) adData = withAd[withAd.length - 1];
    }

    if (adData && adNeedsEnrich(adData)) {
      try {
        adData = await enrichAndStoreAd(String(page_id), String(sender_id), adData);
      } catch (e) {}
    }

    if (!custRow || !custRow.profile_pic) {
      syncCustomerAndAdFromGraph(page_id, sender_id).catch(() => {});
    }

    // চ্যাট খোলা মানেই read — এই কাস্টমারের সব মেসেজ read মার্ক
    try {
      const maxIncoming = incoming.reduce((mx, i) => Math.max(mx, Number(i.time) || 0), 0);
      db.prepare(`
        INSERT INTO mod_reads (page_id, sender_id, read_at) VALUES (?, ?, ?)
        ON CONFLICT(page_id, sender_id) DO UPDATE SET read_at = excluded.read_at
      `).run(String(page_id), String(sender_id), Math.max(Date.now(), maxIncoming));
    } catch (e) {}

    const merged = [...incoming, ...outgoing]
      .map((m) => ({ sender: m.sender, text: m.text, image_url: m.image_url, time: m.time, moderator: m.moderator }))
      .sort((a, b) => (a.time || 0) - (b.time || 0));

    res.json({
      messages: merged,
      ad_data: adData,
      customer: {
        name: (custRow && custRow.name) || `Customer_${String(sender_id).slice(-4)}`,
        profile_pic: (custRow && custRow.profile_pic) || ""
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// সব moderator-এর দিনভিত্তিক হিসাব: /api/mod/stats?date=YYYY-MM-DD&page_id=all|swapons|stone
app.get("/api/mod/stats", requireModAuth, (req, res) => {
  try {
    const rawDate = String(req.query.date || "");
    const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    const scope = resolveScope(req.query.page_id || req.query.scope || "all");
    const pcA = pageClause(scope.ids, "a.page_id");

    const map = new Map();
    const getRow = (raw) => {
      const name = normalizeModeratorName(raw);
      if (!name) return null;
      if (!map.has(name)) {
        map.set(name, {
          name,
          assigned: 0,
          pending: 0,
          average: 0,
          good: 0,
          poor: 0,
          msgsent: 0,
          number: 0,
          messages_sent: 0,
          customers_replied: 0
        });
      }
      return map.get(name);
    };

    const assignRows = db.prepare(`
      SELECT a.moderator, COALESCE(NULLIF(a.bucket, ''), 'pending') AS b,
             COUNT(DISTINCT a.page_id || ':' || a.sender_id) AS cnt
      FROM moderator_assignments a
      WHERE a.day = ? ${pcA.sql}
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.page_id = a.page_id AND m.sender_id = a.sender_id AND ${DAY_M} = ?
        )
      GROUP BY a.moderator, b
    `).all(day, ...pcA.params, day);

    for (const r of assignRows) {
      const row = getRow(r.moderator);
      if (!row) continue;
      row.assigned += r.cnt;
      if (row[r.b] !== undefined) row[r.b] += r.cnt;
    }

    const sentMap = sentMessagesByModerator(day, scope.ids);
    for (const [name, v] of sentMap.entries()) {
      const row = getRow(name);
      if (!row) continue;
      row.messages_sent += v.msgs;
      row.customers_replied += v.custs;
    }

    const rows = Array.from(map.values())
      .filter((r) => r.assigned > 0 || r.messages_sent > 0)
      .sort((a, b) => b.messages_sent - a.messages_sent || b.assigned - a.assigned);

    const total = rows.reduce(
      (t, r) => {
        t.assigned += r.assigned;
        t.pending += r.pending;
        t.average += r.average;
        t.good += r.good;
        t.poor += r.poor;
        t.msgsent += r.msgsent;
        t.number += r.number;
        t.messages_sent += r.messages_sent;
        return t;
      },
      { assigned: 0, pending: 0, average: 0, good: 0, poor: 0, msgsent: 0, number: 0, messages_sent: 0 }
    );

    res.json({ date: day, scope: scope.label, rows, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mod/send", requireModAuth, async (req, res) => {
  try {
    const { page_id, sender_id, text, imageBase64, moderator } = req.body;
    if (!page_id || !sender_id || !moderator || (!text && !imageBase64)) {
      return res.status(400).json({ error: "মেসেজ অথবা ছবি দিন" });
    }

    const now = Date.now();
    const today = dhakaDate();
    let savedImageUrl = null;
    const mid = `mod_${now}_${crypto.randomBytes(3).toString("hex")}`;

    if (imageBase64) {
      const match = imageBase64.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: "Invalid image format" });

      const ext = match[1].split("/")[1].replace("jpeg", "jpg");
      const filename = `img_${now}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
      fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(match[2], "base64"));

      const host = req.get("host");
      const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
      savedImageUrl = `${protocol}://${host}/uploads/${filename}`;
    }

    const cleanText = (text || "").trim();
    const normMod = normalizeModeratorName(moderator) || moderator;
    const isConfirm = cleanText.toLowerCase().includes("your order confirm") ? 1 : 0;

    stmts.insertReply.run(
      page_id,
      sender_id,
      mid,
      cleanText || "[ছবি পাঠানো হয়েছে]",
      savedImageUrl,
      now,
      normMod,
      isConfirm
    );
    stmts.assignModerator.run(page_id, sender_id, today, normMod, now);
    stmts.markReplied.run(page_id, sender_id, today);

    if (savedImageUrl) {
      await sendFacebookPayload(page_id, {
        recipient: { id: sender_id },
        message: {
          attachment: {
            type: "image",
            payload: { url: savedImageUrl, is_reusable: true }
          }
        },
        messaging_type: "RESPONSE"
      });
    }

    if (cleanText) {
      await sendFacebookPayload(page_id, {
        recipient: { id: sender_id },
        message: { text: cleanText },
        messaging_type: "RESPONSE"
      });
    }

    res.json({ success: true, message_id: mid, image_url: savedImageUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

/* Campaign -> Ad sets -> Ads detail */
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

app.get("/api/daily-report", requireAuth, async (req, res) => {
  try {
    const rawDate = String(req.query.date || "");
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    const scope = resolveScope(req.query.page_id || req.query.scope);
    const win = shiftWindow(targetDate, String(req.query.shift || "all"));

    const pc = pageClause(scope.ids);
    const pcM = pageClause(scope.ids, "m.page_id");
    const pcR = pageClause(scope.ids, "r.page_id");

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

    const readNoReply = count(
      `SELECT COUNT(DISTINCT ${CUST_M}) AS count
       FROM messages m
       WHERE m.status = 'read' AND ${DAY_M} = ?${pcM.sql}
         AND NOT EXISTS (
           SELECT 1 FROM replies r
           WHERE r.sender_id = m.sender_id AND r.page_id = m.page_id
             AND ${DAY_R} = ?
         )`,
      [targetDate, ...pcM.params, targetDate]
    );

    const orderConfirms = count(
      `SELECT COUNT(DISTINCT ${CUST}) AS count FROM replies
       WHERE is_order_confirm = 1 AND ${DAY} = ?${pc.sql}`,
      [targetDate, ...pc.params]
    );

    const phoneCount = count(
      `SELECT COUNT(DISTINCT phone_number) AS count FROM messages
       WHERE phone_number IS NOT NULL AND phone_number != '' AND ${DAY} = ?${pc.sql}`,
      [targetDate, ...pc.params]
    );

    /* ------------------------------------------------------------ *
     * Moderator হিসাব (নতুন নিয়ম)
     *  - Customers : যে moderator ওই কাস্টমারকে আজ প্রথম reply দিয়েছে
     *                শুধু তার নামেই ১ customer গোনা হবে
     *  - Messages  : যে যতগুলো মেসেজ পাঠিয়েছে, প্রত্যেকের নামে আলাদা গোনা হবে
     *  - Phones    : কাস্টমার নাম্বার দিলে সেটা প্রথম reply-দাতার নামে যাবে
     * ------------------------------------------------------------ */
    const isShift = win.key !== "all";
    const inShift = (t) => !isShift || (t >= win.startMs && t < win.endMs);

    const dayReplies = db
      .prepare(
        `SELECT r.page_id, r.sender_id, r.moderator, r.reply_time, r.created_at, r.is_order_confirm
         FROM replies r
         WHERE ${DAY_R} = ?${pcR.sql}
         ORDER BY COALESCE(r.reply_time, 0) ASC, r.id ASC`
      )
      .all(targetDate, ...pcR.params);

    const mergedByMod = new Map();
    const ensureMod = (rawMod) => {
      const modName = normalizeModeratorName(rawMod);
      if (!modName) return null;
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

    for (const r of dayReplies) {
      const t = Number(r.reply_time) > 0 ? Number(r.reply_time) : Date.parse(String(r.created_at).replace(" ", "T") + "Z") || 0;
      const cur = ensureMod(r.moderator);

      if (!cur) {
        if (inShift(t)) unattributedMessages += 1;
        continue;
      }

      const custKey = `${r.page_id}:${r.sender_id}`;
      if (!firstByCustomer.has(custKey)) {
        firstByCustomer.set(custKey, { mod: cur.name, time: t });
      }

      if (inShift(t)) {
        cur.total_messages += 1;
        if (r.is_order_confirm) cur.confirmed_orders += 1;
      }
    }

    for (const info of firstByCustomer.values()) {
      if (inShift(info.time)) {
        const cur = ensureMod(info.mod);
        if (cur) cur.total_conversations += 1;
      }
    }

    const phoneMsgs = db
      .prepare(
        `SELECT page_id, sender_id, phone_number
         FROM messages
         WHERE phone_number IS NOT NULL AND phone_number != '' AND ${DAY} = ?${pc.sql}`
      )
      .all(targetDate, ...pc.params);

    const phoneSetByMod = new Map();
    for (const p of phoneMsgs) {
      const first = firstByCustomer.get(`${p.page_id}:${p.sender_id}`);
      if (!first || !inShift(first.time)) continue;
      if (!phoneSetByMod.has(first.mod)) phoneSetByMod.set(first.mod, new Set());
      phoneSetByMod.get(first.mod).add(p.phone_number);
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
        new_customers: Math.max(0, totalReceived - returningCustomers),
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
