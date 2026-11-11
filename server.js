const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

// ড্যাশবোর্ড লগইন তথ্য (প্রয়োজনে পরিবর্তন করতে পারেন)
const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "swapons123";

// অথেন্টিকেশন মিডলওয়্যার (ড্যাশবোর্ড ও API লক করার জন্য)
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Swapons Dashboard"');
    return res.status(401).send("অ্যাক্সেস ডিনাইড! ইউজারনেম ও পাসওয়ার্ড প্রয়োজন।");
  }

  const base64Credentials = authHeader.split(" ")[1];
  const credentials = Buffer.from(base64Credentials, "base64").toString("ascii");
  const [username, password] = credentials.split(":");

  if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Swapons Dashboard"');
  return res.status(401).send("ভুল ইউজারনেম অথবা পাসওয়ার্ড!");
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

// মূল ড্যাশবোর্ড পেজ (ইউজারনেম ও পাসওয়ার্ড দিয়ে সুরক্ষিত)
app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// মেটা ভেরিফিকেশন (Webhook ভেরিফিকেশনে পাসওয়ার্ড লাগবে না)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    console.log("[Meta] Webhook Verified successfully!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// মেটা ইভেন্ট হ্যান্ডলার
app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object === "page") {
    body.entry.forEach((entry) => {
      const pageId = entry.id;

      if (entry.messaging) {
        entry.messaging.forEach((event) => {
          // ১. কাস্টমার মেসেজ
          if (event.message && !event.message.is_echo) {
            const rawText = event.message.text || "";
            const phone = extractPhoneNumber(rawText);

            const stmt = db.prepare(`
              INSERT OR IGNORE INTO messages 
              (page_id, sender_id, message_id, message_text, message_time, phone_number, status)
              VALUES (?, ?, ?, ?, ?, ?, 'unread')
            `);
            stmt.run(
              pageId,
              event.sender.id,
              event.message.mid,
              rawText,
              event.timestamp,
              phone
            );
          }

          // ২. সিন ইভেন্ট
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

          // ৩. পেজ রিপ্লাই
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
            `).run(
              pageId,
              customerId,
              event.message.mid,
              replyText,
              replyTime,
              detectedMod,
              isConfirm
            );

            // প্রথম স্বাগতম মেসেজ লকিং রুল
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

// ড্যাশবোর্ড ডেটা API (ইউজারনেম ও পাসওয়ার্ড দিয়ে সুরক্ষিত)
app.get("/api/daily-report", requireAuth, (req, res) => {
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

    // ১. মোট কাস্টমার মেসেজ
    const totalReceived = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    // ২. উত্তর দেওয়া সম্পন্ন
    const totalReplied = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'replied' AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    // ৩. আনরিড পেন্ডিং
    const unreadPending = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'unread' AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    // ৪. সিন হয়েছে কিন্তু কোনো রিপ্লাই দেওয়া হয়নি (কাস্টমার মেসেজ সিন কিন্তু স্ট্যাটাস 'read')
    const readNoReply = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'read' 
        AND date(created_at, 'localtime') = ? 
        ${pageFilter}
    `).get(...params).count;

    // ৫. অর্ডার কনফার্ম
    const orderConfirms = db.prepare(`
      SELECT COUNT(*) as count FROM replies 
      WHERE is_order_confirm = 1 AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    // ৬. ফোন নম্বর
    const phoneCount = db.prepare(`
      SELECT COUNT(DISTINCT phone_number) as count FROM messages 
      WHERE phone_number IS NOT NULL AND phone_number != '' AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    // মডারেটরদের টেবিল পারফরম্যান্স
    const moderatorStats = db.prepare(`
      SELECT assigned_moderator AS name, COUNT(DISTINCT sender_id) AS total_conversations
      FROM messages
      WHERE assigned_moderator IS NOT NULL 
        AND date(created_at, 'localtime') = ?
        ${pageFilter}
      GROUP BY assigned_moderator
      ORDER BY total_conversations DESC
    `).all(...params);

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
      moderators: moderatorStats
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
