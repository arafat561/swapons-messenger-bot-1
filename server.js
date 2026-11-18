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

const SEEN_NO_REPLY_MS = 5 * 60 * 1000;

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
const DAY_R = "date(r.created_at, '+6 hours')";

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
  { id: "act_846240430355170", name: "Swapons World-3", brand: "swapons", platform: "meta" },
  { id: "act_414594386485433", name: "Swapons World-2", brand: "swapons", platform: "meta" },
  { id: "act_705111815068714", name: "ZXC19 (Stone rose)", brand: "swapons", platform: "meta" },
  { id: "act_412119051932043", name: "ST-18 (Stone Rose)", brand: "swapons", platform: "meta" },
  { id: "act_7707351539304206", name: "ZXC20 (Stone Rose)", brand: "swapons", platform: "meta" },
  { id: "act_770104971706610", name: "ST-09 (Stone Rose)", brand: "swapons", platform: "meta" },
  { id: "act_722336793300354", name: "ST-07 (Stone Rose)", brand: "stone", platform: "meta" },
  { id: "act_3681717408727534", name: "ST-10 (Stone Rose)", brand: "stone", platform: "meta" }
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

const PROVIDED_FB_MAP = new Map([
  ["61594030833722", "FB ID: 61594030833722"],
  ["61594801244167", "FB ID: 61594801244167"],
  ["19ibuyadbj", "FB Share: 19iBuYADbj"],
  ["faria.rahman.800321", "Faria Rahman"],
  ["1phgk91sez", "FB Share: 1PHGk91SEz"],
  ["61592130331098", "FB ID: 61592130331098"],
  ["61591664456446", "FB ID: 61591664456446"],
  ["1crg2mozpq", "FB Share: 1CRG2mozpQ"],
  ["ferdous.fahim.921", "Ferdous Fahim"],
  ["19kyfdy2fr", "FB Share: 19kYfdY2fr"],
  ["61593951013042", "FB ID: 61593951013042"],
  ["61594203401850", "FB ID: 61594203401850"],
  ["61594028540149", "FB ID: 61594028540149"],
  ["1poachcnqh", "FB Share: 1PoAchCNQh"]
]);

const MODERATORS = [
  { name: "ফাহিম", fbProfile: "Ferdous Fahim", aliases: ["ফাহিম", "ferdous.fahim.921"] },
  { name: "ফারিয়া", fbProfile: "Faria Rahman", aliases: ["ফারিয়া", "faria.rahman.800321"] },
  { name: "আজাদ", fbProfile: "FB ID: 61594030833722", aliases: ["আজাদ"] },
  { name: "অপুর্ব", fbProfile: "FB ID: 61594801244167", aliases: ["অপুর্ব", "অপূর্ব"] },
  { name: "আশরাফুল", fbProfile: "FB Share: 19iBuYADbj", aliases: ["আশরাফুল"] },
  { name: "সাইদুল", fbProfile: "FB Share: 1PHGk91SEz", aliases: ["সাইদুল"] },
  { name: "জাবের", fbProfile: "FB ID: 61592130331098", aliases: ["জাবের"] },
  { name: "রিফাত", fbProfile: "FB ID: 61591664456446", aliases: ["রিফাত"] },
  { name: "হালিম", fbProfile: "FB Share: 1CRG2mozpQ", aliases: ["হালিম"] },
  { name: "আল আমিন", fbProfile: "FB Share: 19kYfdY2fr", aliases: ["আল আমিন", "আলআমিন"] },
  { name: "সানজানা", fbProfile: "FB ID: 61593951013042", aliases: ["সানজানা"] },
  { name: "শান্তা", fbProfile: "FB ID: 61594203401850", aliases: ["শান্তা"] },
  { name: "জাকির", fbProfile: "FB ID: 61594028540149", aliases: ["জাকির"] },
  { name: "সামির", fbProfile: "FB Share: 1PoAchCNQh", aliases: ["সামির"] },
  { name: "ইরাম", fbProfile: "FB ID: 61594030833722", aliases: ["ইরাম"] },
  { name: "শুভ্র", fbProfile: "FB ID: 61594801244167", aliases: ["শুভ্র"] },
  { name: "তানিয়া", fbProfile: "FB ID: 61592130331098", aliases: ["তানিয়া"] },
  { name: "আরিফ", fbProfile: "FB ID: 61591664456446", aliases: ["আরিফ"] },
  { name: "আপন", fbProfile: "FB ID: 61593951013042", aliases: ["আপন"] },
  { name: "ফারজানা", fbProfile: "FB ID: 61594203401850", aliases: ["ফারজানা"] }
];

const BN_RANGE = "\\u0980-\\u09FF";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MODERATOR_RULES = MODERATORS.map((m) => {
  const alt = m.aliases
    .map((a) => a.normalize("NFC").trim().split(/\s+/).map(escapeRegex).join("\\s+"))
    .join("|");
  return {
    name: m.name,
    fbProfile: m.fbProfile,
    re: new RegExp(`(?<![${BN_RANGE}])আমি\\s+(?:${alt})(?![${BN_RANGE}])`, "i")
  };
});

function resolveFbProfileLabel(explicitModOrId, text) {
  if (explicitModOrId) {
    const raw = String(explicitModOrId).trim();
    const low = raw.toLowerCase();

    if (PROVIDED_FB_MAP.has(low)) return PROVIDED_FB_MAP.get(low);
    for (const [k, v] of PROVIDED_FB_MAP.entries()) {
      if (low.includes(k)) return v;
    }

    const foundMod = MODERATORS.find(
      (m) => m.name.toLowerCase() === low || m.fbProfile.toLowerCase() === low
    );
    if (foundMod) return foundMod.fbProfile;

    return raw;
  }

  if (text) {
    const clean = String(text).normalize("NFC");
    for (const [k, v] of PROVIDED_FB_MAP.entries()) {
      if (clean.toLowerCase().includes(k)) return v;
    }
    let best = null;
    for (const rule of MODERATOR_RULES) {
      const m = rule.re.exec(clean);
      if (m && (best === null || m.index < best.index)) {
        best = { index: m.index, fbProfile: rule.fbProfile };
      }
    }
    if (best) return best.fbProfile;
  }

  return null;
}

function isOrderConfirmText(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return t.includes("your order is confirm") || t.includes("your order confirm") || t.includes("conversation");
}

function extractElevenDigitPhone(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[\s\-()+]/g, "");
  const match = cleaned.match(/(?:88)?(01\d{9})/);
  return match ? match[1] : null;
}

app.use(express.json({ limit: "35mb" }));

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

  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(page_id, sender_id);
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone_number);
  CREATE INDEX IF NOT EXISTS idx_replies_sender ON replies(page_id, sender_id);
  CREATE INDEX IF NOT EXISTS idx_replies_created_at ON replies(created_at);
  CREATE INDEX IF NOT EXISTS idx_replies_moderator ON replies(moderator);
  CREATE INDEX IF NOT EXISTS idx_assign_day ON moderator_assignments(day);
`);

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
    SET status = 'read', read_time = COALESCE(read_time, ?)
    WHERE page_id = ? AND sender_id = ? AND message_time <= ? AND status = 'unread'
  `),
  insertReply: db.prepare(`
    INSERT INTO replies
    (page_id, sender_id, message_id, reply_text, image_url, reply_time, moderator, is_order_confirm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  assignFirstCustomerOwner: db.prepare(`
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
  purgeSessions: db.prepare(`DELETE FROM sessions WHERE created_at < ?`)
};

function getFirstCustomerOwner(pageId, senderId, day) {
  const row = db.prepare(`
    SELECT moderator FROM moderator_assignments
    WHERE page_id = ? AND sender_id = ? AND day = ?
  `).get(pageId, senderId, day);
  return row ? row.moderator : null;
}

function ensureFirstCustomerOwner(pageId, senderId, day, fbLabel, ts) {
  if (!fbLabel) return null;
  stmts.assignFirstCustomerOwner.run(pageId, senderId, day, fbLabel, ts || Date.now());
  return getFirstCustomerOwner(pageId, senderId, day) || fbLabel;
}

const fbAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

function sendFacebookPayload(pageId, bodyObj) {
  return new Promise((resolve, reject) => {
    const token = getPageToken(pageId);
    if (!token) return reject(new Error(`Page ID (${pageId}) এর জন্য টোকেন সেট করা নেই!`));

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
  if (count >= MAX_FAILS) failedLogins.set(ip, { count: 0, until: Date.now() + BLOCK_MS });
  else failedLogins.set(ip, { count });
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
  if (scheme === "Bearer" && sessionValid(token)) return next();
  return res.status(401).json({ error: "Session ended. Please sign in again." });
}

function requireModAuth(req, res, next) {
  const modPass = req.headers["x-mod-pass"];
  if (modPass === MOD_PASS || modPass === DASHBOARD_PASS || modPass === "swapon123") return next();
  return res.status(401).json({ error: "ভুল মডারেটর পাসওয়ার্ড!" });
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/inbox", (req, res) => res.sendFile(path.join(__dirname, "inbox.html")));
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

function extractAdReferral(event) {
  const ref = event.referral || (event.message && event.message.referral) || (event.postback && event.postback.referral);
  if (!ref) return null;
  const ctx = ref.ads_context_data || {};
  const adId = ref.ad_id || "";
  const postUrl = ctx.post_url || (adId ? `https://www.facebook.com/ads/library/?id=${adId}` : "");
  const photoUrl = ctx.photo_url || ctx.video_url || "";
  if (isBlockedStickerUrl(photoUrl) || isBlockedStickerUrl(postUrl)) return null;

  return JSON.stringify({
    ad_id: adId,
    ad_title: ctx.ad_title || ref.ref || (adId ? `Facebook Ad #${adId}` : "Facebook Ad"),
    post_url: postUrl,
    photo_url: photoUrl
  });
}

async function handleMessagingEvent(pageId, event) {
  const ts = event.timestamp || Date.now();
  const day = dhakaDate(ts);
  const senderId = event.sender && event.sender.id;
  const adInfoJson = extractAdReferral(event);

  if (adInfoJson && senderId && (!event.message || !event.message.is_echo)) {
    db.prepare(`
      INSERT INTO customers (page_id, sender_id, ad_info) VALUES (?, ?, ?)
      ON CONFLICT(page_id, sender_id) DO UPDATE SET ad_info = excluded.ad_info
    `).run(pageId, senderId, adInfoJson);
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
    const phone11 = extractElevenDigitPhone(rawText);
    const firstOwner = getFirstCustomerOwner(pageId, senderId, day);

    stmts.insertMessage.run(
      pageId,
      senderId,
      event.message.mid,
      displayText,
      imageUrl,
      adInfoJson,
      ts,
      phone11
    );

    if (firstOwner) {
      db.prepare(`
        UPDATE messages SET assigned_moderator = ?
        WHERE page_id = ? AND sender_id = ? AND ${DAY} = ? AND (assigned_moderator IS NULL OR assigned_moderator = '')
      `).run(firstOwner, pageId, senderId, day);
    }

    db.prepare(`
      UPDATE moderator_assignments SET bucket = 'pending'
      WHERE page_id = ? AND sender_id = ? AND day = ? AND bucket != 'pending'
    `).run(pageId, senderId, day);

    return;
  }

  if (event.postback || event.referral) {
    const mid = (event.postback && event.postback.mid) || `ref_${senderId}_${ts}`;
    const text = (event.postback && (event.postback.title || event.postback.payload)) || "📢 Ad থেকে ইনবক্সে এসেছেন";
    stmts.insertMessage.run(pageId, senderId, mid, text, null, adInfoJson, ts, extractElevenDigitPhone(text));
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

    const isConfirm = isOrderConfirmText(replyText) ? 1 : 0;
    const fbLabel = resolveFbProfileLabel(null, replyText);
    const firstCustomerOwner = ensureFirstCustomerOwner(pageId, customerId, day, fbLabel, ts);

    const exists = db.prepare(`SELECT id FROM replies WHERE message_id = ?`).get(event.message.mid);
    if (!exists) {
      stmts.insertReply.run(
        pageId,
        customerId,
        event.message.mid,
        replyText || (replyImg ? "[ছবি]" : "👍"),
        replyImg,
        ts,
        fbLabel || firstCustomerOwner,
        isConfirm
      );
    }

    if (firstCustomerOwner) {
      db.prepare(`
        UPDATE messages SET assigned_moderator = ?
        WHERE page_id = ? AND sender_id = ? AND ${DAY} = ? AND (assigned_moderator IS NULL OR assigned_moderator = '')
      `).run(firstCustomerOwner, pageId, customerId, day);
    }

    stmts.markReplied.run(pageId, customerId, day);
    return;
  }

  if (event.read) {
    const readAt = event.read.watermark || ts;
    stmts.markRead.run(readAt, pageId, senderId, readAt);
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

app.get("/api/mod/search-phone", requireModAuth, (req, res) => {
  try {
    const qRaw = String(req.query.phone || "").replace(/[\s\-()+]/g, "");
    if (!qRaw) return res.status(400).json({ error: "ফোন নম্বর দিন" });

    const rows = db.prepare(`
      SELECT
        m.page_id,
        m.sender_id,
        m.phone_number,
        m.message_text,
        m.message_time,
        COALESCE(NULLIF(c.name, ''), 'Customer_' || substr(m.sender_id, -4)) AS customer_name,
        (
          SELECT a.moderator FROM moderator_assignments a
          WHERE a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = date(m.created_at, '+6 hours')
          LIMIT 1
        ) AS first_owner_fb_profile,
        (
          SELECT GROUP_CONCAT(DISTINCT r.moderator) FROM replies r
          WHERE r.page_id = m.page_id AND r.sender_id = m.sender_id AND r.moderator IS NOT NULL
        ) AS sent_by_fb_profiles
      FROM messages m
      LEFT JOIN customers c ON m.page_id = c.page_id AND m.sender_id = c.sender_id
      WHERE m.phone_number LIKE ?
      ORDER BY m.message_time DESC
      LIMIT 30
    `).all(`%${qRaw}%`);

    res.json({
      query: qRaw,
      matches: rows.map((r) => ({
        ...r,
        page_name: PAGE_NAMES[r.page_id] || "Page"
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/mod/list", (req, res) => {
  res.json({
    moderators: MODERATORS.map((m) => ({
      name: m.name,
      fb_profile: m.fbProfile
    })),
    mapped_profiles: Array.from(PROVIDED_FB_MAP.values())
  });
});

app.post("/api/mod/batch", requireModAuth, async (req, res) => {
  try {
    const { moderator, requestNew, pageFilter, bucket } = req.body;
    if (!moderator) return res.status(400).json({ error: "Moderator name required" });

    const fbLabel = resolveFbProfileLabel(moderator, null) || moderator;
    const today = dhakaDate();
    const activeBucket = ["pending", "average", "good", "poor"].includes(bucket) ? bucket : "pending";
    const scope = resolveScope(pageFilter || "all");
    const pcM = pageClause(scope.ids, "m.page_id");

    const getBucketCustomers = (targetBucket) => {
      return db.prepare(`
        SELECT 
          m.page_id,
          m.sender_id,
          COALESCE(NULLIF(MAX(c.name), ''), 'Customer_' || substr(m.sender_id, -4)) as customer_name,
          MAX(c.profile_pic) as profile_pic,
          COALESCE(MAX(c.ad_info), MAX(m.ad_info)) as ad_info,
          MAX(m.message_text) as last_message,
          MAX(m.message_time) as last_time,
          COUNT(m.id) as msg_count
        FROM messages m
        JOIN moderator_assignments a 
          ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
        LEFT JOIN customers c ON m.page_id = c.page_id AND m.sender_id = c.sender_id
        WHERE a.moderator = ?
          AND COALESCE(NULLIF(a.bucket, ''), 'pending') = ?
          AND ${DAY_M} = ?
          ${pcM.sql}
        GROUP BY m.page_id, m.sender_id
        ORDER BY MIN(m.id) ASC
      `).all(today, fbLabel, targetBucket, today, ...pcM.params);
    };

    let pendingQueue = getBucketCustomers("pending");
    const slotsNeeded = 10 - pendingQueue.length;
    if (slotsNeeded > 0 && (activeBucket === "pending" || requestNew)) {
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
      `).all(today, today, ...pcM.params, slotsNeeded);

      const assignTransaction = db.transaction((list) => {
        const now = Date.now();
        for (const item of list) {
          stmts.assignFirstCustomerOwner.run(item.page_id, item.sender_id, today, fbLabel, now);
        }
      });
      assignTransaction(unassignedCustomers);
      pendingQueue = getBucketCustomers("pending");
    }

    const currentList = activeBucket === "pending" ? pendingQueue : getBucketCustomers(activeBucket);
    const countRows = db.prepare(`
      SELECT COALESCE(NULLIF(a.bucket, ''), 'pending') as b, COUNT(DISTINCT a.page_id || ':' || a.sender_id) as cnt
      FROM moderator_assignments a
      JOIN messages m ON m.page_id = a.page_id AND m.sender_id = a.sender_id AND ${DAY_M} = ?
      WHERE a.day = ? AND a.moderator = ? ${pcM.sql}
      GROUP BY b
    `).all(today, today, fbLabel, ...pcM.params);

    const counts = { pending: 0, average: 0, good: 0, poor: 0 };
    countRows.forEach((r) => {
      if (counts[r.b] !== undefined) counts[r.b] = r.cnt;
    });

    res.json({
      moderator: moderator,
      fb_profile: fbLabel,
      bucket: activeBucket,
      counts,
      queue: currentList.map((q) => ({
        ...q,
        page_name: PAGE_NAMES[q.page_id] || "Page"
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/mod/chat", requireModAuth, async (req, res) => {
  try {
    const { page_id, sender_id } = req.query;
    const incoming = db.prepare(`
      SELECT 'customer' as sender, COALESCE(NULLIF(message_text, ''), '👍') as text, image_url, ad_info, message_time as time, phone_number, NULL as sent_by_fb_profile
      FROM messages
      WHERE page_id = ? AND sender_id = ?
    `).all(page_id, sender_id);

    const outgoing = db.prepare(`
      SELECT 'page' as sender, COALESCE(NULLIF(reply_text, ''), '👍') as text, image_url, NULL as ad_info, reply_time as time, NULL as phone_number, moderator as sent_by_fb_profile
      FROM replies
      WHERE page_id = ? AND sender_id = ?
    `).all(page_id, sender_id);

    const custRow = db.prepare(`SELECT name, profile_pic, ad_info FROM customers WHERE page_id = ? AND sender_id = ?`).get(page_id, sender_id);
    const merged = [...incoming, ...outgoing].sort((a, b) => (a.time || 0) - (b.time || 0));

    res.json({
      messages: merged.map((m) => ({
        ...m,
        sent_by_label: m.sender === "page" && m.sent_by_fb_profile ? `Sent by ${m.sent_by_fb_profile}` : null
      })),
      customer: {
        name: (custRow && custRow.name) || `Customer_${String(sender_id).slice(-4)}`,
        profile_pic: (custRow && custRow.profile_pic) || ""
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mod/send", requireModAuth, async (req, res) => {
  try {
    const { page_id, sender_id, text, imageBase64, imagesBase64, moderator } = req.body;
    const imgList = Array.isArray(imagesBase64) && imagesBase64.length > 0
      ? imagesBase64
      : (imageBase64 ? [imageBase64] : []);

    if (!page_id || !sender_id || !moderator || (!text && imgList.length === 0)) {
      return res.status(400).json({ error: "মেসেজ অথবা ছবি দিন" });
    }

    const baseNow = Date.now();
    const day = dhakaDate(baseNow);
    const fbLabel = resolveFbProfileLabel(moderator, text) || moderator;
    const firstCustomerOwner = ensureFirstCustomerOwner(page_id, sender_id, day, fbLabel, baseNow);

    const host = req.get("host");
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const savedUrls = [];

    for (let i = 0; i < imgList.length; i++) {
      const b64 = imgList[i];
      const match = String(b64).match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: "Invalid image format" });

      const ext = match[1].split("/")[1].replace("jpeg", "jpg");
      const filename = `img_${baseNow}_${i}_${crypto.randomBytes(3).toString("hex")}.${ext}`;
      fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(match[2], "base64"));
      savedUrls.push(`${protocol}://${host}/uploads/${filename}`);
    }

    const cleanText = (text || "").trim();
    const isConfirm = isOrderConfirmText(cleanText) ? 1 : 0;

    for (let i = 0; i < savedUrls.length; i++) {
      const t = baseNow + i;
      const mid = `mod_${t}_${crypto.randomBytes(3).toString("hex")}`;
      stmts.insertReply.run(page_id, sender_id, mid, "[ছবি পাঠানো হয়েছে]", savedUrls[i], t, fbLabel, 0);
      await sendFacebookPayload(page_id, {
        recipient: { id: sender_id },
        message: {
          attachment: { type: "image", payload: { url: savedUrls[i], is_reusable: true } }
        },
        messaging_type: "RESPONSE"
      });
    }

    if (cleanText) {
      const tText = baseNow + savedUrls.length;
      const midText = `mod_${tText}_${crypto.randomBytes(3).toString("hex")}`;
      stmts.insertReply.run(page_id, sender_id, midText, cleanText, null, tText, fbLabel, isConfirm);
      await sendFacebookPayload(page_id, {
        recipient: { id: sender_id },
        message: { text: cleanText },
        messaging_type: "RESPONSE"
      });
    }

    stmts.markReplied.run(page_id, sender_id, day);
    res.json({
      success: true,
      customer_owner: firstCustomerOwner,
      sent_by_fb_profile: fbLabel,
      sent_by_label: `Sent by ${fbLabel}`,
      image_urls: savedUrls
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function fetchAllInsights(url) {
  return new Promise(async (resolve) => {
    let rows = [];
    let next = url;
    let guard = 0;
    while (next && guard < 20) {
      const r = await httpsGetJson(next);
      if (!r) return resolve({ rows, error: "Meta API-তে সংযোগ হয়নি" });
      if (r.error) return resolve({ rows, error: r.error.message || "Meta API error" });
      if (Array.isArray(r.data)) rows = rows.concat(r.data);
      next = r.paging && r.paging.next ? r.paging.next : null;
      guard += 1;
    }
    resolve({ rows, error: null });
  });
}

async function fetchMetaAccountRow(acc, targetDate) {
  const cleanId = acc.id.replace(/\s+/g, "");
  let remainingUsd = null;
  let spendingLimitUsd = null;
  let accountError = null;

  try {
    const accParams = new URLSearchParams({
      access_token: META_ACCESS_TOKEN,
      fields: "spend_cap,amount_spent"
    });
    const accInfo = await httpsGetJson(`https://graph.facebook.com/${META_API_VERSION}/${cleanId}?${accParams.toString()}`);
    if (accInfo && !accInfo.error) {
      const capRaw = parseFloat(accInfo.spend_cap || 0);
      const spentRaw = parseFloat(accInfo.amount_spent || 0);
      if (capRaw > 0) {
        spendingLimitUsd = capRaw / 100;
        remainingUsd = Math.max(0, (capRaw - spentRaw) / 100);
      }
    } else if (accInfo && accInfo.error) {
      accountError = accInfo.error.message;
    }
  } catch (e) {}

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
    const { rows, error } = await fetchAllInsights(url);
    if (error && !accountError) accountError = error;

    let totalSpend = 0;
    let totalMessages = 0;
    let totalOrders = 0;
    let msgSpend = 0;
    let salesSpend = 0;

    rows.forEach((camp) => {
      const campSpend = parseFloat(camp.spend || 0);
      totalSpend += campSpend;
      let campMsgs = 0;
      let campOrders = 0;
      if (camp.actions) {
        const msgAction = camp.actions.find((a) => a.action_type === "onsite_conversion.messaging_conversation_started_7d");
        if (msgAction) campMsgs = parseInt(msgAction.value || 0, 10);
        const orderAction = camp.actions.find((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
        if (orderAction) campOrders = parseInt(orderAction.value || 0, 10);
      }
      totalMessages += campMsgs;
      totalOrders += campOrders;

      if (campMsgs > 0 && campOrders === 0) msgSpend += campSpend;
      else if (campOrders > 0 && campMsgs === 0) salesSpend += campSpend;
      else {
        if (campMsgs > 0) msgSpend += campSpend / 2;
        if (campOrders > 0) salesSpend += campSpend / 2;
      }
    });

    return {
      id: cleanId,
      name: acc.name,
      brand: acc.brand,
      platform: "meta",
      remaining_usd: remainingUsd !== null ? remainingUsd.toFixed(2) : null,
      spending_limit_usd: spendingLimitUsd !== null ? spendingLimitUsd.toFixed(2) : null,
      spend: totalSpend.toFixed(2),
      messages: totalMessages,
      msg_spend: msgSpend.toFixed(2),
      cost_per_msg_cents: totalMessages > 0 && msgSpend > 0 ? ((msgSpend / totalMessages) * 100).toFixed(1) : "0.0",
      orders: totalOrders,
      sales_spend: salesSpend.toFixed(2),
      cost_per_order_usd: totalOrders > 0 && salesSpend > 0 ? (salesSpend / totalOrders).toFixed(2) : "0.00",
      campaigns: [],
      error: accountError
    };
  } catch (err) {
    return {
      id: cleanId,
      name: acc.name,
      brand: acc.brand,
      platform: "meta",
      remaining_usd: remainingUsd !== null ? remainingUsd.toFixed(2) : null,
      spending_limit_usd: spendingLimitUsd !== null ? spendingLimitUsd.toFixed(2) : null,
      spend: "0.00",
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
}

async function fetchAdsMetrics(targetDate, brand) {
  const accounts = AD_ACCOUNTS.filter((a) => brand === "all" || a.brand === brand);
  const results = await Promise.all(
    accounts.map((acc) => {
      if (!META_ACCESS_TOKEN) {
        return Promise.resolve({
          id: acc.id,
          name: acc.name,
          brand: acc.brand,
          platform: "meta",
          remaining_usd: null,
          spending_limit_usd: null,
          spend: "0.00",
          messages: 0,
          msg_spend: "0.00",
          cost_per_msg_cents: "0.0",
          orders: 0,
          sales_spend: "0.00",
          cost_per_order_usd: "0.00",
          campaigns: [],
          error: null
        });
      }
      return fetchMetaAccountRow(acc, targetDate);
    })
  );

  const sum = (key) => results.reduce((acc, cur) => acc + parseFloat(cur[key] || 0), 0);
  const totalSpendSum = sum("spend");
  const totalMsgsSum = results.reduce((acc, cur) => acc + cur.messages, 0);
  const totalOrdersSum = results.reduce((acc, cur) => acc + cur.orders, 0);
  const totalMsgSpendSum = sum("msg_spend");
  const totalSalesSpendSum = sum("sales_spend");
  const hasAnyRemaining = results.some((r) => r.remaining_usd !== null && r.remaining_usd !== undefined);
  const totalRemainingSum = results.reduce(
    (acc, cur) => acc + (cur.remaining_usd !== null && cur.remaining_usd !== undefined ? parseFloat(cur.remaining_usd) : 0),
    0
  );

  return {
    configured: Boolean(META_ACCESS_TOKEN),
    meta_configured: Boolean(META_ACCESS_TOKEN),
    has_error: results.some((r) => r.error),
    accounts: results,
    summary: {
      total_spend: totalSpendSum.toFixed(2),
      total_remaining_usd: hasAnyRemaining ? totalRemainingSum.toFixed(2) : null,
      has_remaining: hasAnyRemaining,
      total_messages: totalMsgsSum,
      msg_spend: totalMsgSpendSum.toFixed(2),
      avg_cost_per_msg_cents: totalMsgsSum > 0 && totalMsgSpendSum > 0 ? ((totalMsgSpendSum / totalMsgsSum) * 100).toFixed(1) : "0.0",
      total_orders: totalOrdersSum,
      sales_spend: totalSalesSpendSum.toFixed(2),
      avg_cost_per_order_usd: totalOrdersSum > 0 && totalSalesSpendSum > 0 ? (totalSalesSpendSum / totalOrdersSum).toFixed(2) : "0.00"
    }
  };
}

const adsCache = new Map();
async function getAdsMetrics(date, brand) {
  const key = `${date}|${brand}`;
  const hit = adsCache.get(key);
  if (hit && Date.now() - hit.t < 60 * 1000) return hit.v;
  const v = await fetchAdsMetrics(date, brand);
  if (!v.has_error) adsCache.set(key, { t: Date.now(), v });
  if (adsCache.size > 100) adsCache.clear();
  return v;
}

app.get("/api/daily-report", requireAuth, async (req, res) => {
  try {
    const rawDate = String(req.query.date || "");
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    const scope = resolveScope(req.query.page_id || req.query.scope);
    const win = shiftWindow(targetDate, String(req.query.shift || "all"));
    const nowMs = Date.now();

    const pc = pageClause(scope.ids);
    const pcM = pageClause(scope.ids, "m.page_id");
    const pcA = pageClause(scope.ids, "a.page_id");
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

    const seenNoReply5Min = count(
      `SELECT COUNT(DISTINCT ${CUST_M}) AS count
       FROM messages m
       WHERE m.status = 'read'
         AND m.read_time IS NOT NULL
         AND (? - m.read_time) >= ?
         AND ${DAY_M} = ?${pcM.sql}
         AND NOT EXISTS (
           SELECT 1 FROM replies r
           WHERE r.sender_id = m.sender_id AND r.page_id = m.page_id
             AND ${DAY_R} = ?
         )`,
      [nowMs, SEEN_NO_REPLY_MS, targetDate, ...pcM.params, targetDate]
    );

    const orderConfirms = count(
      `SELECT COUNT(DISTINCT ${CUST}) AS count FROM replies
       WHERE (
         is_order_confirm = 1
         OR lower(reply_text) LIKE '%your order is confirm%'
         OR lower(reply_text) LIKE '%conversation%'
       ) AND ${DAY} = ?${pc.sql}`,
      [targetDate, ...pc.params]
    );

    const phoneCount = count(
      `SELECT COUNT(DISTINCT phone_number) AS count FROM messages
       WHERE phone_number GLOB '01[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
         AND ${DAY} = ?${pc.sql}`,
      [targetDate, ...pc.params]
    );

    const isShift = win.key !== "all";
    const shiftAssignSql = isShift ? " AND a.assigned_at >= ? AND a.assigned_at < ?" : "";
    const shiftReplySql = isShift ? " AND r.reply_time >= ? AND r.reply_time < ?" : "";
    const shiftParams = isShift ? [win.startMs, win.endMs] : [];

    const custRows = db
      .prepare(
        `SELECT a.moderator AS name,
                COUNT(DISTINCT a.page_id || ':' || a.sender_id) AS total_customers
         FROM moderator_assignments a
         WHERE a.day = ?${shiftAssignSql}${pcA.sql}
         GROUP BY a.moderator`
      )
      .all(targetDate, ...shiftParams, ...pcA.params);

    const msgRows = db
      .prepare(
        `SELECT r.moderator AS name,
                COUNT(r.id) AS total_messages
         FROM replies r
         WHERE r.moderator IS NOT NULL AND r.moderator != ''
           AND ${DAY_R} = ?${shiftReplySql}${pcR.sql}
         GROUP BY r.moderator`
      )
      .all(targetDate, ...shiftParams, ...pcR.params);

    const phoneRows = db
      .prepare(
        `SELECT a.moderator AS name,
                COUNT(DISTINCT m.phone_number) AS phones
         FROM messages m
         JOIN moderator_assignments a
           ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
         WHERE m.phone_number GLOB '01[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
           AND ${DAY_M} = ?${shiftAssignSql}${pcA.sql}
         GROUP BY a.moderator`
      )
      .all(targetDate, targetDate, ...shiftParams, ...pcA.params);

    const custByName = new Map(custRows.map((c) => [c.name, c.total_customers]));
    const msgByName = new Map(msgRows.map((m) => [m.name, m.total_messages]));
    const phoneByName = new Map(phoneRows.map((p) => [p.name, p.phones]));

    const allNames = new Set([
      ...custByName.keys(),
      ...msgByName.keys(),
      ...phoneByName.keys()
    ]);

    const moderatorStats = Array.from(allNames)
      .map((name) => {
        const custCount = custByName.get(name) || 0;
        const msgCount = msgByName.get(name) || 0;
        return {
          name,
          total_customers: custCount,
          total_conversations: custCount,
          total_messages: msgCount,
          phone_numbers: phoneByName.get(name) || 0,
          msgs_per_customer: custCount ? Math.round((msgCount / custCount) * 10) / 10 : 0,
          avg_minutes_per_message:
            win.elapsed_minutes && msgCount
              ? Math.round((win.elapsed_minutes / msgCount) * 10) / 10
              : null
        };
      })
      .sort((a, b) => b.total_customers - a.total_customers || b.total_messages - a.total_messages);

    const adsData = await getAdsMetrics(targetDate, scope.key);

    res.json({
      date: targetDate,
      generated_at: nowMs,
      scope: { key: scope.key, label: scope.label },
      shift: { key: win.key, label: win.label, minutes: win.minutes, elapsed_minutes: win.elapsed_minutes },
      page_id: req.query.page_id || "all",
      page_name: scope.label,
      stats: {
        total_received: totalReceived,
        total_raw_messages: totalRawMessages,
        returning_customers: returningCustomers,
        new_customers: Math.max(0, totalReceived - returningCustomers),
        total_replied: totalReplied,
        unread_pending: unreadPending,
        read_without_reply: seenNoReply5Min,
        seen_no_reply_grace_minutes: 5,
        total_confirmed_orders: orderConfirms,
        total_phone_numbers: phoneCount
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
