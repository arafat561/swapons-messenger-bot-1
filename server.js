const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

// পেজ ম্যাপিং
const PAGES = {
  "1133872699971391": "Swapon's World",
  "250386238168336": "Stone Rose BD"
};

app.use(express.json());

// ক্লাউডে স্থায়ী ডিস্ক /data থাকলে সেখানে সেভ হবে, অন্যথায় লোকাল ফোল্ডারে
const dbDir = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : ".");
const dbPath = path.join(dbDir, "messenger.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// টেবিল তৈরি ও কলাম মাইগ্রেশন
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    message_id TEXT,
    reply_text TEXT,
    reply_time INTEGER,
    is_order_confirm INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(page_id, sender_id);
`);

// পূর্বের ডাটাবেস থাকলে কলাম অ্যাড করার সেফটি চেক
try { db.exec(`ALTER TABLE messages ADD COLUMN read_time INTEGER;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN phone_number TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN is_order_confirm INTEGER DEFAULT 0;`); } catch (e) {}

// ফোন নাম্বার ফিল্টার করার হেল্পার ফাংশন
function extractPhoneNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:\+?88)?01[3-9]\d{8}\b/);
  return match ? match[0] : null;
}

// প্রিমিয়াম ও মডার্ন ড্যাশবোর্ডের মূল HTML
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ডেইলি মেসেঞ্জার ও অর্ডার রিপোর্ট</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
      color: #1e293b;
      min-height: 100vh;
      padding: 40px 20px;
    }
    .container {
      max-width: 1050px;
      margin: 0 auto;
    }
    .header-card {
      background: #ffffff;
      padding: 24px 30px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.03);
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 28px;
    }
    .title-area {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .badge-live {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #dcfce7;
      color: #15803d;
      font-size: 13px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 9999px;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background-color: #22c55e;
      border-radius: 50%;
      box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7);
      animation: pulse 1.6s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }
    .header-card h2 {
      font-size: 22px;
      font-weight: 700;
      color: #0f172a;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .controls select, .controls input {
      padding: 10px 14px;
      border: 1.5px solid #cbd5e1;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      color: #334155;
      outline: none;
      background: #f8fafc;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .controls select:focus, .controls input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
      background: #fff;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
    }
    .card {
      background: #ffffff;
      padding: 26px 22px;
      border-radius: 16px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.03);
      border: 1px solid #f1f5f9;
      position: relative;
      overflow: hidden;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .card:hover {
      transform: translateY(-4px);
      box-shadow: 0 15px 30px -5px rgba(0, 0, 0, 0.08);
    }
    .card::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
    }
    .card h3 {
      font-size: 14px;
      font-weight: 600;
      color: #64748b;
      margin-bottom: 14px;
      line-height: 1.4;
    }
    .card .count {
      font-size: 38px;
      font-weight: 800;
      letter-spacing: -1px;
    }
    .blue::before { background: linear-gradient(90deg, #3b82f6, #60a5fa); }
    .blue .count { color: #2563eb; }
    .green::before { background: linear-gradient(90deg, #10b981, #34d399); }
    .green .count { color: #059669; }
    .red::before { background: linear-gradient(90deg, #ef4444, #f87171); }
    .red .count { color: #dc2626; }
    .orange::before { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .orange .count { color: #d97706; }
    .purple::before { background: linear-gradient(90deg, #8b5cf6, #a78bfa); }
    .purple .count { color: #7c3aed; }
    .teal::before { background: linear-gradient(90deg, #0d9488, #2dd4bf); }
    .teal .count { color: #0f766e; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-card">
      <div class="title-area">
        <h2 id="dashboardTitle">📊 পেজ রিপোর্ট</h2>
        <span class="badge-live"><span class="pulse-dot"></span> লাইভ</span>
      </div>
      <div class="controls">
        <select id="pagePicker" onchange="fetchReport()">
          <option value="all">সব পেজ (একসাথে)</option>
          <option value="1133872699971391">Swapon's World</option>
          <option value="250386238168336">Stone Rose BD</option>
        </select>
        <input type="date" id="datePicker" onchange="fetchReport()">
      </div>
    </div>
    
    <div class="grid">
      <div class="card blue">
        <h3>১. মোট কাস্টমার মেসেজ এসেছে</h3>
        <div class="count" id="total_received">0</div>
      </div>
      <div class="card green">
        <h3>২. উত্তর দেওয়া সম্পন্ন হয়েছে</h3>
        <div class="count" id="total_replied">0</div>
      </div>
      <div class="card red">
        <h3>৩. দেখা হয়নি (Unread / উত্তর বাকি)</h3>
        <div class="count" id="unread_pending">0</div>
      </div>
      <div class="card orange">
        <h3>৪. সিন হয়েছে কিন্তু ২ মিনিটে রিপ্লাই নেই</h3>
        <div class="count" id="read_without_reply">0</div>
      </div>
      <div class="card purple">
        <h3>৫. কনফার্ম অর্ডার (Your order confirm)</h3>
        <div class="count" id="total_confirmed_orders">0</div>
      </div>
      <div class="card teal">
        <h3>৬. ফোন নম্বর এসেছে (ইউনিক কাস্টমার)</h3>
        <div class="count" id="total_phone_numbers">0</div>
      </div>
    </div>
  </div>

  <script>
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('datePicker').value = today;

    async function fetchReport() {
      try {
        const date = document.getElementById('datePicker').value;
        const pagePicker = document.getElementById('pagePicker');
        const pageId = pagePicker.value;
        const selectedText = pagePicker.options[pagePicker.selectedIndex].text;
        
        document.getElementById('dashboardTitle').innerText = '📊 ' + selectedText + ' রিপোর্ট';

        let url = '/api/daily-report?date=' + date;
        if (pageId && pageId !== 'all') {
          url += '&page_id=' + pageId;
        }

        const res = await fetch(url);
        const data = await res.json();
        document.getElementById('total_received').innerText = data.stats.total_received;
        document.getElementById('total_replied').innerText = data.stats.total_replied;
        document.getElementById('unread_pending').innerText = data.stats.unread_pending;
        document.getElementById('read_without_reply').innerText = data.stats.read_without_reply;
        document.getElementById('total_confirmed_orders').innerText = data.stats.total_confirmed_orders;
        document.getElementById('total_phone_numbers').innerText = data.stats.total_phone_numbers;
      } catch (err) {
        console.error('Failed to load report:', err);
      }
    }

    fetchReport();
    setInterval(fetchReport, 5000);
  </script>
</body>
</html>
`;

// রুট ভিউ (ড্যাশবোর্ড)
app.get("/", (req, res) => {
  res.send(DASHBOARD_HTML);
});

// মেটা ভেরিফিকেশন (GET /webhook)
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

// মেটা ইভেন্ট প্রসেসিং (POST /webhook)
app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object === "page") {
    body.entry.forEach((entry) => {
      const pageId = entry.id;

      if (entry.messaging) {
        entry.messaging.forEach((event) => {
          // কাস্টমার মেসেজ
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

          // সিন ইভেন্ট (সিন হওয়ার সময় মিলিসেকেন্ড সেভ রাখা)
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

          // পেজ রিপ্লাই
          if (event.message && event.message.is_echo) {
            const customerId = event.recipient.id;
            const replyText = event.message.text || "";
            
            // "your order confirm" চেক
            const isConfirm = replyText.toLowerCase().includes("your order confirm") ? 1 : 0;

            db.prepare(`
              INSERT INTO replies 
              (page_id, sender_id, message_id, reply_text, reply_time, is_order_confirm)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              pageId,
              customerId,
              event.message.mid,
              replyText,
              event.timestamp,
              isConfirm
            );

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

// প্রাইভেসি পলিসি রাউট
app.get("/privacy-policy", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Privacy Policy</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; padding: 40px 20px; max-width: 750px; margin: auto; color: #1e293b; }
        h1 { font-size: 28px; margin-bottom: 8px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; }
        p { margin-bottom: 16px; color: #475569; }
      </style>
    </head>
    <body>
      <h1>Privacy Policy</h1>
      <p>Last updated: November 2026</p>
      <p>Our Messenger bot application collects incoming message timestamps, customer volumes, and order status sent to our Facebook Pages to generate daily performance analytics.</p>
    </body>
    </html>
  `);
});

// সক্রিয় সব পেজের আইডি পাওয়ার API
app.get("/api/pages", (req, res) => {
  try {
    const pages = db.prepare(`SELECT DISTINCT page_id FROM messages WHERE page_id IS NOT NULL AND page_id != ''`).all();
    res.json(pages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ড্যাশবোর্ড ডেটা API
app.get("/api/daily-report", (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().slice(0, 10);
    const targetPage = req.query.page_id;

    let pageFilter = "";
    let params = [targetDate];

    if (targetPage && targetPage !== "all") {
      pageFilter = " AND page_id = ?";
      params = [targetDate, targetPage];
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

    // ৪. সিন হয়েছে কিন্তু ২ মিনিট পার হয়ে গেলেও রিপ্লাই নেই (120,000 ms)
    const twoMinutesAgo = Date.now() - (2 * 60 * 1000);
    let readParams = [targetDate, twoMinutesAgo];
    let readPageFilter = "";
    if (targetPage && targetPage !== "all") {
      readPageFilter = " AND page_id = ?";
      readParams = [targetDate, twoMinutesAgo, targetPage];
    }

    const readNoReply = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'read' 
      AND date(created_at, 'localtime') = ? 
      AND (read_time IS NULL OR read_time <= ?)
      ${readPageFilter}
    `).get(...readParams).count;

    // ৫. কনফার্ম অর্ডার (replies টেবিলে 'your order confirm' টেক্সট পাঠানো হয়েছে)
    const orderConfirms = db.prepare(`
      SELECT COUNT(*) as count FROM replies 
      WHERE is_order_confirm = 1 AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    // ৬. ফোন নাম্বার এসেছে (ইউনিক নম্বর)
    const phoneCount = db.prepare(`
      SELECT COUNT(DISTINCT phone_number) as count FROM messages 
      WHERE phone_number IS NOT NULL AND phone_number != '' AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

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
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
