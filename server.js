const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const https = require("https");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "swapons123";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";

// ৯টি অ্যাড অ্যাকাউন্টের শতভাগ নির্ভুল ম্যাপিং
const AD_ACCOUNTS = [
  { id: "act_705111815068714", name: "ZXC19 (Stone rose)" },
  { id: "act_722336793300354", name: "ST-07 (Stone Rose)" },
  { id: "act_3681717408727534", name: "ST-10 (Stone Rose)" },
  { id: "act_770104971706610", name: "ST-09 (Stone Rose)" },
  { id: "act_412119051932043", name: "ST-18 (Stone Rose)" },
  { id: "act_7707351539304206", name: "ZXC20 (Stone Rose)" },
  { id: "act_846240430355170", name: "Swapons World-3" },
  { id: "act_414594386485433", name: "Swapons World-2" },
  { id: "act_2788254531383177", name: "SW-BM" }
];

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "অনুমতি নেই! ইউজারনেম ও পাসওয়ার্ড প্রয়োজন।" });
  }

  const base64Credentials = authHeader.split(" ")[1];
  if (!base64Credentials) {
    return res.status(401).json({ error: "ভুল ফরমেট!" });
  }

  const credentials = Buffer.from(base64Credentials, "base64").toString("ascii");
  const [username, password] = credentials.split(":");

  if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
    return next();
  }

  return res.status(401).json({ error: "ভুল ইউজারনেম অথবা পাসওয়ার্ড!" });
}

const PAGES = {
  "102803132669088": "Swapons World",
  "1133872699971391": "Swapons World",
  "250386238168336": "Stone Rose BD"
};

const MODERATOR_RULES = [
  { name: 'ফাহিম', keywords: ['আমি ফাহিম', 'ফাহিম'] },
  { name: 'আজাদ', keywords: ['আমি আজাদ', 'আজাদ'] },
  { name: 'অপুর্ব', keywords: ['আমি অপুর্ব', 'অপুর্ব', 'অপূর্ব'] },
  { name: 'আশরাফুল', keywords: ['আমি আশরাফুল', 'আশরাফুল'] },
  { name: 'সাইদুল', keywords: ['আমি সাইদুল', 'সাইদুল'] },
  { name: 'জাবের', keywords: ['আমি জাবের', 'জাবের'] },
  { name: 'রিফাত', keywords: ['আমি রিফাত', 'রিফাত'] },
  { name: 'হালিম', keywords: ['আমি হালিম', 'হালিম'] },
  { name: 'আল আমিন', keywords: ['আমি আল আমিন', 'আল আমিন'] },
  { name: 'সানজানা', keywords: ['আমি সানজানা', 'সানজানা'] },
  { name: 'শান্তা', keywords: ['আমি শান্তা', 'শান্তা'] },
  { name: 'জাকির', keywords: ['আমি জাকির', 'জাকির'] },
  { name: 'সামির', keywords: ['আমি সামির', 'সামির'] },
  { name: 'ইরাম', keywords: ['আমি ইরাম', 'ইরাম'] },
  { name: 'শুভ্র', keywords: ['আমি শুভ্র', 'শুভ্র'] },
  { name: 'তানিয়া', keywords: ['আমি তানিয়া', 'তানিয়া'] },
  { name: 'আরিফ', keywords: ['আমি আরিফ', 'আরিফ'] }
];

function detectModerator(text) {
  if (!text) return null;
  const clean = text.toLowerCase();
  for (const mod of MODERATOR_RULES) {
    for (const kw of mod.keywords) {
      if (clean.includes(kw.toLowerCase())) {
        return mod.name;
      }
    }
  }
  return null;
}

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

  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(page_id, sender_id);
`);

try { db.exec(`ALTER TABLE messages ADD COLUMN read_time INTEGER;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN phone_number TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN assigned_moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN is_order_confirm INTEGER DEFAULT 0;`); } catch (e) {}

function extractPhoneNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:\+?88)?01[3-9]\d{8}\b/);
  return match ? match[0] : null;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

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

app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object === "page") {
    body.entry.forEach((entry) => {
      const pageId = entry.id;

      if (entry.messaging) {
        entry.messaging.forEach((event) => {
          if (event.message && !event.message.is_echo) {
            const rawText = event.message.text || "";
            const phone = extractPhoneNumber(rawText);

            const stmt = db.prepare(`
              INSERT OR IGNORE INTO messages 
              (page_id, sender_id, message_id, message_text, message_time, phone_number, status)
              VALUES (?, ?, ?, ?, ?, ?, 'unread')
            `);
            stmt.run(pageId, event.sender.id, event.message.mid, rawText, event.timestamp, phone);
          }

          if (event.read) {
            const customerId = event.sender.id;
            const watermark = event.read.watermark;
            const readTime = Date.now();

            db.prepare(`
              UPDATE messages 
              SET status = 'read', read_time = ? 
              WHERE page_id = ? AND sender_id = ? AND message_time <= ? AND status = 'unread'
            `).run(readTime, pageId, customerId, watermark);
          }

          if (event.message && event.message.is_echo) {
            const customerId = event.recipient.id;
            const replyText = event.message.text || "";
            const replyTime = event.timestamp || Date.now();

            const isConfirm = replyText.toLowerCase().includes("your order confirm") ? 1 : 0;
            const detectedMod = detectModerator(replyText);

            db.prepare(`
              INSERT INTO replies 
              (page_id, sender_id, message_id, reply_text, reply_time, moderator, is_order_confirm)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(pageId, customerId, event.message.mid, replyText, replyTime, detectedMod, isConfirm);

            if (detectedMod) {
              db.prepare(`
                UPDATE messages 
                SET assigned_moderator = ? 
                WHERE page_id = ? 
                  AND sender_id = ? 
                  AND assigned_moderator IS NULL
                  AND date(created_at, 'localtime') = date('now', 'localtime')
              `).run(detectedMod, pageId, customerId);
            }

            db.prepare(`
              UPDATE messages 
              SET status = 'replied' 
              WHERE page_id = ? AND sender_id = ? AND status != 'replied'
            `).run(pageId, customerId);
          }
        });
      }
    });

    return res.status(200).send("EVENT_RECEIVED");
  }

  res.sendStatus(404);
});

function httpsGet(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let rawData = "";
      res.on("data", (chunk) => { rawData += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(rawData));
        } catch (e) {
          resolve(null);
        }
      });
    }).on("error", () => {
      resolve(null);
    });
  });
}

// মেটা এপিআই থেকে বিজ্ঞাপন পারফরম্যান্সের নির্ভুল ফেচ
async function fetchMetaAdsMetrics(targetDate) {
  if (!META_ACCESS_TOKEN) return { accounts: [], summary: {} };

  // আজ হলে সরাসরি মেটার date_preset=today ব্যবহার হবে, অন্য তারিখে time_range
  const todayStr = new Date().toISOString().slice(0, 10);
  let dateQuery = "date_preset=today";
  if (targetDate && targetDate !== todayStr) {
    dateQuery = `time_range=${encodeURIComponent(JSON.stringify({ since: targetDate, until: targetDate }))}`;
  }

  const promises = AD_ACCOUNTS.map(async (acc) => {
    try {
      const cleanId = acc.id.replace(/\s+/g, "");
      // ক্যাম্পেইন লেভেলে ডেটা আনা যাতে Sales ক্যাম্পেইন এবং Messaging ক্যাম্পেইনের স্পেন্ড আলাদাভাবে সঠিক থাকে
      const url = `https://graph.facebook.com/v19.0/${cleanId}/insights?access_token=${META_ACCESS_TOKEN}&${dateQuery}&level=campaign&fields=spend,actions,cost_per_action_type`;
      const response = await httpsGet(url);

      let totalSpend = 0;
      let totalMessages = 0;
      let totalOrders = 0;
      let salesSpend = 0;
      let msgSpend = 0;

      if (response && response.data && response.data.length > 0) {
        response.data.forEach((camp) => {
          const campSpend = parseFloat(camp.spend || 0);
          totalSpend += campSpend;

          let campMsgs = 0;
          let campOrders = 0;

          if (camp.actions) {
            // ১. নির্ভুল মেসেজ সংখ্যা (ডুপ্লিকেট ছাড়া একক আইডি)
            const msgAction = camp.actions.find(a => 
              a.action_type === "onsite_conversion.messaging_conversation_started_7d" ||
              a.action_type === "onsite_conversion.messaging_first_reply"
            );
            if (msgAction) {
              campMsgs = parseInt(msgAction.value || 0, 10);
            }

            // ২. নির্ভুল ওয়েবসাইট পারচেজ / অর্ডার (ডুপ্লিকেট ফিল্টার ছাড়া কেবল একটি কাউন্ট)
            const orderAction = camp.actions.find(a => 
              a.action_type === "purchase" ||
              a.action_type === "offsite_conversion.fb_pixel_purchase"
            );
            if (orderAction) {
              campOrders = parseInt(orderAction.value || 0, 10);
            }
          }

          totalMessages += campMsgs;
          totalOrders += campOrders;

          if (campOrders > 0) salesSpend += campSpend;
          if (campMsgs > 0) msgSpend += campSpend;
        });
      }

      // কস্ট পার মেসেজ (সেন্ট) এবং কস্ট পার পারচেজ (ডলার) মেটার হিসাব অনুযায়ী
      const costPerMsgCents = totalMessages > 0 
        ? (((msgSpend > 0 ? msgSpend : totalSpend) / totalMessages) * 100).toFixed(1) 
        : 0;

      const costPerOrderUsd = totalOrders > 0 
        ? ((salesSpend > 0 ? salesSpend : totalSpend) / totalOrders).toFixed(2) 
        : "0.00";

      return {
        id: cleanId,
        name: acc.name,
        spend: totalSpend.toFixed(2),
        messages: totalMessages,
        cost_per_msg_cents: costPerMsgCents,
        orders: totalOrders,
        cost_per_order_usd: costPerOrderUsd
      };
    } catch (err) {
      return {
        id: acc.id,
        name: acc.name,
        spend: "0.00",
        messages: 0,
        cost_per_msg_cents: 0,
        orders: 0,
        cost_per_order_usd: "0.00"
      };
    }
  });

  const results = await Promise.all(promises);

  const totalSpendSum = results.reduce((acc, curr) => acc + parseFloat(curr.spend || 0), 0);
  const totalMsgsSum = results.reduce((acc, curr) => acc + curr.messages, 0);
  const totalOrdersSum = results.reduce((acc, curr) => acc + curr.orders, 0);

  const avgCostPerMsgCents = totalMsgsSum > 0 ? ((totalSpendSum / totalMsgsSum) * 100).toFixed(1) : 0;
  const avgCostPerOrderUsd = totalOrdersSum > 0 ? (totalSpendSum / totalOrdersSum).toFixed(2) : "0.00";

  return {
    accounts: results,
    summary: {
      total_spend: totalSpendSum.toFixed(2),
      total_messages: totalMsgsSum,
      avg_cost_per_msg_cents: avgCostPerMsgCents,
      total_orders: totalOrdersSum,
      avg_cost_per_order_usd: avgCostPerOrderUsd
    }
  };
}

app.get("/api/daily-report", requireAuth, async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().slice(0, 10);
    const targetPage = req.query.page_id;

    let pageFilter = "";
    let params = [targetDate];

    if (targetPage && targetPage !== "all") {
      if (targetPage === "102803132669088" || targetPage === "1133872699971391") {
        pageFilter = " AND page_id IN ('102803132669088', '1133872699971391')";
      } else {
        pageFilter = " AND page_id = ?";
        params.push(targetPage);
      }
    }

    const totalReceived = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    const totalReplied = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'replied' AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    const unreadPending = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'unread' AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    const readNoReply = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'read' 
        AND date(created_at, 'localtime') = ? 
        ${pageFilter}
    `).get(...params).count;

    const orderConfirms = db.prepare(`
      SELECT COUNT(*) as count FROM replies 
      WHERE is_order_confirm = 1 AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    const phoneCount = db.prepare(`
      SELECT COUNT(DISTINCT phone_number) as count FROM messages 
      WHERE phone_number IS NOT NULL AND phone_number != '' AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    const moderatorStats = db.prepare(`
      SELECT assigned_moderator AS name, COUNT(DISTINCT sender_id) AS total_conversations
      FROM messages
      WHERE assigned_moderator IS NOT NULL 
        AND date(created_at, 'localtime') = ?
        ${pageFilter}
      GROUP BY assigned_moderator
      ORDER BY total_conversations DESC
    `).all(...params);

    const adsData = await fetchMetaAdsMetrics(targetDate);

    res.json({
      date: targetDate,
      page_id: targetPage || "all",
      page_name: targetPage && PAGES[targetPage] ? PAGES[targetPage] : "All Pages",
      stats: {
        total_received: totalReceived,
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
    res.status(500).json({ error: err.message });
  }
});

app.get("/privacy-policy", (req, res) => {
  res.send(`<h1>Privacy Policy</h1><p>Analytics application for connected Facebook pages.</p>`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
