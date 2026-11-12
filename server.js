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

// লগইন: ইউজারনেম swapon, পাসওয়ার্ড swapon@1234 (চাইলে .env এ DASHBOARD_USER / DASHBOARD_PASS দিয়ে বদলানো যাবে)
const DASHBOARD_USER = process.env.DASHBOARD_USER || "swapon";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "swapon@1234";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
// Marketing API version: আগের v19.0 মেয়াদোত্তীর্ণ। চাইলে .env এ META_API_VERSION দিয়ে বদলানো যাবে।
const META_API_VERSION = process.env.META_API_VERSION || "v25.0";

// একবার সাইন-ইন করলে আর মেয়াদ শেষ হয় না — Sign out চাপা পর্যন্ত (বা পাসওয়ার্ড বদলানো পর্যন্ত) ড্যাশবোর্ড খোলা থাকে।
// আবার সময়-সীমা চাইলে .env এ SESSION_MINUTES=5 দিন। (০ বা ফাঁকা = মেয়াদ নেই)
const SESSION_MINUTES = Number(process.env.SESSION_MINUTES || 0);
const SESSION_MS = SESSION_MINUTES > 0 ? SESSION_MINUTES * 60 * 1000 : 0;

if (!process.env.DASHBOARD_PASS) {
  console.warn("⚠️  DASHBOARD_PASS সেট করা নেই — ডিফল্ট পাসওয়ার্ড চলছে। চাইলে .env এ নতুন পাসওয়ার্ড দিন।");
}

/* ------------------------------------------------------------------ */
/* সময়: সব দিনের হিসাব বাংলাদেশ সময় (UTC+6) অনুযায়ী                    */
/* ------------------------------------------------------------------ */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

function dhakaDate(ts) {
  const t = typeof ts === "number" ? ts : Date.now();
  return new Date(t + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

const DAY = "date(created_at, '+6 hours')";
const DAY_M = "date(m.created_at, '+6 hours')";
const DAY_R = "date(r.created_at, '+6 hours')";

/* ------------------------------------------------------------------ */
/* শিফট: সকাল ৯টা–বিকাল ৫টা (৪৮০ মিনিট), বিকাল ৫টা–রাত ১২টা (৪২০ মিনিট) */
/* সময় বদলাতে চাইলে শুধু startH / endH বদলান (ঘণ্টা, বাংলাদেশ সময়)।       */
/* ------------------------------------------------------------------ */
const SHIFTS = {
  all: { label: "Full day", startH: 0, endH: 24 },
  morning: { label: "Morning (9am–5pm)", startH: 9, endH: 17 },
  evening: { label: "Evening (5pm–12am)", startH: 17, endH: 24 }
};

function sqlTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function shiftWindow(dateStr, shiftKey) {
  const key = SHIFTS[shiftKey] ? shiftKey : "all";
  const s = SHIFTS[key];
  const dayStartMs = Date.parse(dateStr + "T00:00:00Z") - DHAKA_OFFSET_MS;
  const startMs = dayStartMs + s.startH * 3600000;
  const endMs = dayStartMs + s.endH * 3600000;
  const full = key === "all" ? null : (s.endH - s.startH) * 60;
  // শিফট চলতে থাকলে এখন পর্যন্ত যত মিনিট গেছে সেটাই ধরা হয়
  const elapsed = key === "all" ? null : Math.max(0, Math.min(endMs, Date.now()) - startMs) / 60000;
  return {
    key,
    label: s.label,
    start: sqlTime(startMs),
    end: sqlTime(endMs),
    minutes: full,
    elapsed_minutes: elapsed === null ? null : Math.round(elapsed * 10) / 10
  };
}

/* ------------------------------------------------------------------ */
/* পেজ ও অ্যাড অ্যাকাউন্ট                                              */
/* ------------------------------------------------------------------ */
const PAGE_GROUPS = {
  swapons: { label: "Swapons World", ids: ["102803132669088", "1133872699971391"] },
  stone: { label: "Stone Rose BD", ids: ["250386238168336"] }
};

const PAGE_TO_GROUP = {
  "102803132669088": "swapons",
  "1133872699971391": "swapons",
  "250386238168336": "stone"
};

// ৮টি অ্যাড অ্যাকাউন্ট। brand দিয়ে ঠিক হয় কোন অ্যাকাউন্ট কোন পেজের হিসাবে দেখাবে।
// কোনোটা ভুল গ্রুপে পড়লে শুধু ওই লাইনের brand বদলে দিন ("swapons" অথবা "stone")।
const AD_ACCOUNTS = [
  // Swapons World এর অ্যাড (৬টি অ্যাকাউন্ট)
  { id: "act_846240430355170", name: "Swapons World-3", brand: "swapons" },
  { id: "act_414594386485433", name: "Swapons World-2", brand: "swapons" },
  { id: "act_705111815068714", name: "ZXC19 (Stone rose)", brand: "swapons" },
  { id: "act_412119051932043", name: "ST-18 (Stone Rose)", brand: "swapons" },
  { id: "act_7707351539304206", name: "ZXC20 (Stone Rose)", brand: "swapons" },
  { id: "act_770104971706610", name: "ST-09 (Stone Rose)", brand: "swapons" },

  // Stone Rose এর অ্যাড (শুধু ২টি অ্যাকাউন্ট: ST-07 ও ST-10)
  { id: "act_722336793300354", name: "ST-07 (Stone Rose)", brand: "stone" },
  { id: "act_3681717408727534", name: "ST-10 (Stone Rose)", brand: "stone" }

  // SW-BM (act_2788254531383177) বাদ দেওয়া হয়েছে — ওতে কোনো অ্যাড চলে না।
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

/* ------------------------------------------------------------------ */
/* মডারেটর শনাক্তকরণ                                                   */
/* শুধু "আমি <নাম>" লেখা থাকলে এবং নামের পরে আর কোনো বাংলা অক্ষর/কার       */
/* চিহ্ন না থাকলে মিলবে। "আমি ইরাম ।" ✔   "আমি আপনার" ✘                  */
/* ------------------------------------------------------------------ */
const MODERATORS = [
  { name: "ফাহিম", aliases: ["ফাহিম"] },
  { name: "আজাদ", aliases: ["আজাদ"] },
  { name: "অপুর্ব", aliases: ["অপুর্ব", "অপূর্ব"] },
  { name: "আশরাফুল", aliases: ["আশরাফুল"] },
  { name: "সাইদুল", aliases: ["সাইদুল"] },
  { name: "জাবের", aliases: ["জাবের"] },
  { name: "রিফাত", aliases: ["রিফাত"] },
  { name: "হালিম", aliases: ["হালিম"] },
  { name: "আল আমিন", aliases: ["আল আমিন", "আলআমিন"] },
  { name: "সানজানা", aliases: ["সানজানা"] },
  { name: "শান্তা", aliases: ["শান্তা"] },
  { name: "জাকির", aliases: ["জাকির"] },
  { name: "সামির", aliases: ["সামির"] },
  { name: "ইরাম", aliases: ["ইরাম"] },
  { name: "শুভ্র", aliases: ["শুভ্র"] },
  { name: "তানিয়া", aliases: ["তানিয়া"] },
  { name: "আরিফ", aliases: ["আরিফ"] },
  { name: "আপন", aliases: ["আপন"] },
  { name: "ফারজানা", aliases: ["ফারজানা"] }
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
    re: new RegExp(`(?<![${BN_RANGE}])আমি\\s+(?:${alt})(?![${BN_RANGE}])`)
  };
});

function detectModerator(text) {
  if (!text) return null;
  const clean = String(text).normalize("NFC");
  let best = null;
  for (const rule of MODERATOR_RULES) {
    const m = rule.re.exec(clean);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, name: rule.name };
    }
  }
  return best ? best.name : null;
}

/* ------------------------------------------------------------------ */
/* ডাটাবেস                                                             */
/* ------------------------------------------------------------------ */
app.use(express.json());

const dbDir = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : ".");
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
    reply_time INTEGER,
    moderator TEXT,
    is_order_confirm INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- একজন কাস্টমার, একটি দিন, একজন মডারেটর। প্রথম ওয়েলকাম মেসেজই লক হয়ে যায়।
  -- ওই কাস্টমারের পাঠানো ফোন নম্বরও এই মডারেটরের নামেই গোনা হয়।
  CREATE TABLE IF NOT EXISTS moderator_assignments (
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    day TEXT NOT NULL,
    moderator TEXT NOT NULL,
    assigned_at INTEGER,
    PRIMARY KEY (page_id, sender_id, day)
  );

  -- ড্যাশবোর্ড লগইন সেশন (টোকেনের হ্যাশ রাখা হয়, আসল টোকেন নয়)
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(page_id, sender_id);
  CREATE INDEX IF NOT EXISTS idx_replies_sender ON replies(page_id, sender_id);
  CREATE INDEX IF NOT EXISTS idx_replies_created_at ON replies(created_at);
  CREATE INDEX IF NOT EXISTS idx_assign_day ON moderator_assignments(day);
`);

try { db.exec(`ALTER TABLE messages ADD COLUMN read_time INTEGER;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN phone_number TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN assigned_moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN is_order_confirm INTEGER DEFAULT 0;`); } catch (e) {}

function createdAtToDay(createdAt) {
  const ms = Date.parse(String(createdAt).replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : dhakaDate(ms);
}

/* একবারের মাইগ্রেশন: পুরোনো replies থেকে নতুন নিয়মে মডারেটর হিসাব আবার তৈরি করে। */
if (db.pragma("user_version", { simple: true }) < 1) {
  const rows = db
    .prepare(`SELECT id, page_id, sender_id, reply_text, reply_time, created_at FROM replies ORDER BY id ASC`)
    .all();

  const insertAssign = db.prepare(`
    INSERT OR IGNORE INTO moderator_assignments (page_id, sender_id, day, moderator, assigned_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const fixReply = db.prepare(`UPDATE replies SET moderator = ? WHERE id = ?`);

  const rebuild = db.transaction((list) => {
    for (const r of list) {
      const mod = detectModerator(r.reply_text);
      fixReply.run(mod, r.id);
      if (!mod) continue;
      const day = createdAtToDay(r.created_at);
      if (day) insertAssign.run(r.page_id, r.sender_id, day, mod, r.reply_time || null);
    }
  });

  rebuild(rows);
  db.pragma("user_version = 1");
  console.log(`✅ মডারেটর হিসাব নতুন নিয়মে পুনর্গঠিত হয়েছে (${rows.length}টি রিপ্লাই)`);
}

const stmts = {
  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages
    (page_id, sender_id, message_id, message_text, message_time, phone_number, status)
    VALUES (?, ?, ?, ?, ?, ?, 'unread')
  `),
  markRead: db.prepare(`
    UPDATE messages
    SET status = 'read', read_time = ?
    WHERE page_id = ? AND sender_id = ? AND message_time <= ? AND status = 'unread'
  `),
  insertReply: db.prepare(`
    INSERT INTO replies
    (page_id, sender_id, message_id, reply_text, reply_time, moderator, is_order_confirm)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  assignModerator: db.prepare(`
    INSERT OR IGNORE INTO moderator_assignments (page_id, sender_id, day, moderator, assigned_at)
    VALUES (?, ?, ?, ?, ?)
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

function extractPhoneNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:\+?88)?01[3-9]\d{8}\b/);
  return match ? match[0] : null;
}

/* ------------------------------------------------------------------ */
/* লগইন ও সেশন                                                         */
/* সাইন-ইন করলে একটি টোকেন তৈরি হয় এবং ডাটাবেসে (হ্যাশ করে) জমা থাকে।      */
/* তাই সার্ভার রিস্টার্ট দিলেও লগইন থাকে। পাসওয়ার্ড বদলালে সব সেশন বাতিল।   */
/* ------------------------------------------------------------------ */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ইউজারনেম/পাসওয়ার্ড বদলালে এটাও বদলে যায়, ফলে পুরোনো টোকেন আর মিলবে না।
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

// ভুল পাসওয়ার্ড বারবার দিলে সাময়িক ব্লক (ব্রুট-ফোর্স ঠেকাতে)
const failedLogins = new Map(); // ip -> { count, until }
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

  if (safeEqual(username, DASHBOARD_USER) && safeEqual(password, DASHBOARD_PASS)) {
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

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
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

function handleMessagingEvent(pageId, event) {
  // ১. কাস্টমারের মেসেজ
  if (event.message && !event.message.is_echo) {
    const rawText = event.message.text || "";
    stmts.insertMessage.run(
      pageId,
      event.sender.id,
      event.message.mid,
      rawText,
      event.timestamp,
      extractPhoneNumber(rawText)
    );
    return;
  }

  // ২. কাস্টমার বাটন/আইস-ব্রেকারে ট্যাপ করলে (Meta এটাকেও "conversation started" ধরে)
  if (event.postback) {
    const ts = event.timestamp || Date.now();
    const mid = event.postback.mid || `pb_${event.sender.id}_${ts}`;
    const text = event.postback.title || event.postback.payload || "[button]";
    stmts.insertMessage.run(pageId, event.sender.id, mid, text, ts, extractPhoneNumber(text));
    return;
  }

  // ৩. পেজ/মডারেটরের পাঠানো রিপ্লাই (echo)
  if (event.message && event.message.is_echo) {
    const customerId = event.recipient && event.recipient.id;
    if (!customerId) return;

    const replyText = event.message.text || "";
    const replyTime = event.timestamp || Date.now();
    const isConfirm = replyText.toLowerCase().includes("your order confirm") ? 1 : 0;
    const mod = detectModerator(replyText);
    const today = dhakaDate();

    stmts.insertReply.run(pageId, customerId, event.message.mid, replyText, replyTime, mod, isConfirm);

    // প্রথম ওয়েলকাম মেসেজই কাউন্ট হবে (PRIMARY KEY + INSERT OR IGNORE)
    if (mod) stmts.assignModerator.run(pageId, customerId, today, mod, replyTime);

    stmts.markReplied.run(pageId, customerId, today);
    return;
  }

  // ৪. কাস্টমার মেসেজ দেখেছে (read receipt)
  if (event.read) {
    stmts.markRead.run(Date.now(), pageId, event.sender.id, event.read.watermark);
  }
}

app.post("/webhook", (req, res) => {
  const body = req.body;
  if (!body || body.object !== "page") return res.sendStatus(404);

  for (const entry of body.entry || []) {
    const pageId = String(entry.id);
    for (const event of entry.messaging || []) {
      try {
        handleMessagingEvent(pageId, event);
      } catch (err) {
        console.error("webhook event error:", err.message);
      }
    }
  }

  return res.status(200).send("EVENT_RECEIVED");
});

/* ------------------------------------------------------------------ */
/* Meta Ads                                                            */
/* ------------------------------------------------------------------ */
function httpsGetJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
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

// Meta ডিফল্টে ২৫টির বেশি ক্যাম্পেইন একবারে দেয় না — তাই limit বাড়িয়ে পরের পেজও আনা হচ্ছে।
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
        fields: "campaign_name,objective,spend,actions",
        time_range: JSON.stringify({ since: targetDate, until: targetDate }),
        use_unified_attribution_setting: "true",
        limit: "500"
      });
      const url = `https://graph.facebook.com/${META_API_VERSION}/${cleanId}/insights?${params.toString()}`;
      const { rows, error } = await fetchAllInsights(url);

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

        if (campMsgs > 0 && campOrders === 0) {
          msgSpend += campSpend;
        } else if (campOrders > 0 && campMsgs === 0) {
          salesSpend += campSpend;
        } else if (isMsgObj && !isSalesObj) {
          msgSpend += campSpend;
        } else if (isSalesObj && !isMsgObj) {
          salesSpend += campSpend;
        } else {
          if (campMsgs > 0) msgSpend += campSpend / 2;
          if (campOrders > 0) salesSpend += campSpend / 2;
        }
      });

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
        messages: totalMessages,
        msg_spend: msgSpend.toFixed(2),
        cost_per_msg_cents: costPerMsgCents,
        orders: totalOrders,
        sales_spend: salesSpend.toFixed(2),
        cost_per_order_usd: costPerOrderUsd,
        error: error || null
      };
    } catch (err) {
      return {
        id: cleanId,
        name: acc.name,
        brand: acc.brand,
        spend: "0.00",
        messages: 0,
        msg_spend: "0.00",
        cost_per_msg_cents: "0.0",
        orders: 0,
        sales_spend: "0.00",
        cost_per_order_usd: "0.00",
        error: err.message
      };
    }
  });

  const results = await Promise.all(promises);

  const sum = (key) => results.reduce((acc, cur) => acc + parseFloat(cur[key] || 0), 0);
  const totalSpendSum = sum("spend");
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

// ৩০ সেকেন্ডে অটো-রিফ্রেশে Meta API যেন বারবার ডাক না পড়ে — ৬০ সেকেন্ড ক্যাশ।
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

/* ------------------------------------------------------------------ */
/* ড্যাশবোর্ড API                                                      */
/* ------------------------------------------------------------------ */
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

    // মোট ইনবক্স কাস্টমার: ওই দিনে যেকোনো উৎস (অ্যাড / ডাইরেক্ট / পুরোনো কাস্টমার) থেকে
    // যতজন মেসেজ দিয়েছে, প্রত্যেকে ১ জন — ১০-২০টা মেসেজ দিলেও ১ জন।
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

    // মডারেটর: যে কাস্টমার যার নামে লক (প্রথম ওয়েলকাম), তাকে পাঠানো সব রিপ্লাই তার।
    //  - Customers = কতজন আলাদা কাস্টমারকে মেসেজ দিয়েছে (১০টা মেসেজ দিলেও ১ জন)
    //  - Messages  = মোট কতটা মেসেজ পাঠিয়েছে
    //  - Phones    = ওই মডারেটরের লক করা কাস্টমারদের পাঠানো আলাদা ফোন নম্বর
    // শিফট বাছলে শুধু ওই সময়ের মধ্যে পাঠানো মেসেজ / আসা ফোন নম্বর গোনা হয়।
    const modRows = db
      .prepare(
        `SELECT a.moderator AS name,
                COUNT(DISTINCT r.page_id || ':' || r.sender_id) AS total_conversations,
                COUNT(*) AS total_messages
         FROM replies r
         JOIN moderator_assignments a
           ON a.page_id = r.page_id AND a.sender_id = r.sender_id AND a.day = ?
         WHERE r.created_at >= ? AND r.created_at < ?${pcR.sql}
         GROUP BY a.moderator`
      )
      .all(targetDate, win.start, win.end, ...pcR.params);

    // কাস্টমার আগে ফোন নম্বর দিক বা পরে — যে মডারেটর ওই কথোপকথনের প্রথম ওয়েলকাম দিয়েছে, নম্বর তার।
    const phoneRows = db
      .prepare(
        `SELECT a.moderator AS name,
                COUNT(DISTINCT m.phone_number) AS phones
         FROM messages m
         JOIN moderator_assignments a
           ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
         WHERE m.phone_number IS NOT NULL AND m.phone_number != ''
           AND m.created_at >= ? AND m.created_at < ?${pcM.sql}
         GROUP BY a.moderator`
      )
      .all(targetDate, win.start, win.end, ...pcM.params);

    const phoneByMod = new Map(phoneRows.map((p) => [p.name, p.phones]));
    const board = modRows.map((m) => ({
      name: m.name,
      total_conversations: m.total_conversations,
      total_messages: m.total_messages
    }));
    // শিফটে যার শুধু ফোন নম্বর এসেছে (রিপ্লাই নেই) তাকেও তালিকায় রাখা হয়।
    for (const p of phoneRows) {
      if (!board.some((b) => b.name === p.name)) {
        board.push({ name: p.name, total_conversations: 0, total_messages: 0 });
      }
    }
    board.sort(
      (a, b) =>
        b.total_conversations - a.total_conversations ||
        b.total_messages - a.total_messages ||
        (phoneByMod.get(b.name) || 0) - (phoneByMod.get(a.name) || 0) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );

    const moderatorStats = board.map((m) => ({
      name: m.name,
      total_conversations: m.total_conversations,
      total_messages: m.total_messages,
      phone_numbers: phoneByMod.get(m.name) || 0,
      msgs_per_customer: m.total_conversations
        ? Math.round((m.total_messages / m.total_conversations) * 10) / 10
        : 0,
      // ডিউটির মিনিট ÷ পাঠানো মেসেজ। "Full day" এ ডিউটি সময় ঠিক করা যায় না, তাই null।
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

