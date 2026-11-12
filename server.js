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

const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "swapons123";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
// Marketing API version: আগের v19.0 মেয়াদোত্তীর্ণ। চাইলে .env এ META_API_VERSION দিয়ে বদলানো যাবে।
const META_API_VERSION = process.env.META_API_VERSION || "v25.0";

if (!process.env.DASHBOARD_PASS) {
  console.warn("⚠️  DASHBOARD_PASS সেট করা নেই — ডিফল্ট পাসওয়ার্ড চলছে। .env এ নতুন পাসওয়ার্ড দিন।");
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

// brand দিয়ে ঠিক হয় কোন অ্যাড অ্যাকাউন্ট কোন পেজের।
// কোনোটা ভুল গ্রুপে পড়লে শুধু এখানে brand বদলে দিন।
const AD_ACCOUNTS = [
  { id: "act_705111815068714", name: "ZXC19 (Stone rose)", brand: "stone" },
  { id: "act_722336793300354", name: "ST-07 (Stone Rose)", brand: "stone" },
  { id: "act_3681717408727534", name: "ST-10 (Stone Rose)", brand: "stone" },
  { id: "act_770104971706610", name: "ST-09 (Stone Rose)", brand: "stone" },
  { id: "act_412119051932043", name: "ST-18 (Stone Rose)", brand: "stone" },
  { id: "act_7707351539304206", name: "ZXC20 (Stone Rose)", brand: "stone" },
  { id: "act_846240430355170", name: "Swapons World-3", brand: "swapons" },
  { id: "act_414594386485433", name: "Swapons World-2", brand: "swapons" },
  { id: "act_2788254531383177", name: "SW-BM", brand: "swapons" }
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
/* লগইন                                                                */
/* ------------------------------------------------------------------ */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme !== "Basic" || !encoded) {
    return res.status(401).json({ error: "অনুমতি নেই! ইউজারনেম ও পাসওয়ার্ড প্রয়োজন।" });
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const username = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";

  if (safeEqual(username, DASHBOARD_USER) && safeEqual(password, DASHBOARD_PASS)) {
    return next();
  }
  return res.status(401).json({ error: "ভুল ইউজারনেম অথবা পাসওয়ার্ড!" });
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
  CREATE TABLE IF NOT EXISTS moderator_assignments (
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    day TEXT NOT NULL,
    moderator TEXT NOT NULL,
    assigned_at INTEGER,
    PRIMARY KEY (page_id, sender_id, day)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(page_id, sender_id);
  CREATE INDEX IF NOT EXISTS idx_replies_sender ON replies(page_id, sender_id);
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
  `)
};

function extractPhoneNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:\+?88)?01[3-9]\d{8}\b/);
  return match ? match[0] : null;
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

    const pc = pageClause(scope.ids);
    const pcM = pageClause(scope.ids, "m.page_id");

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

    // মডারেটর: কার ওয়েলকাম মেসেজ আগে গেছে, সেই কাস্টমার তার।
    const moderatorStats = db
      .prepare(
        `SELECT moderator AS name, COUNT(*) AS total_conversations
         FROM moderator_assignments
         WHERE day = ?${pc.sql}
         GROUP BY moderator
         ORDER BY total_conversations DESC, moderator ASC`
      )
      .all(targetDate, ...pc.params);

    const adsData = await getAdsMetrics(targetDate, scope.key);

    res.json({
      date: targetDate,
      generated_at: Date.now(),
      scope: { key: scope.key, label: scope.label },
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
