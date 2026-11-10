const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

app.use(express.json());

// ক্লাউডে স্থায়ী ডিস্ক /data থাকলে সেখানে সেভ হবে, অন্যথায় লোকাল ফোল্ডারে
const dbDir = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : ".");
const dbPath = path.join(dbDir, "messenger.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// টেবিল তৈরি
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    message_id TEXT UNIQUE,
    message_text TEXT,
    message_time INTEGER,
    status TEXT DEFAULT 'unread',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    message_id TEXT,
    reply_text TEXT,
    reply_time INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(page_id, sender_id);
`);

// প্রিমিয়াম ও মডার্ন ড্যাশবোর্ডের মূল HTML
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ডেইলি মেসেঞ্জার রিপোর্ট - স্বপন'স ওয়ার্ল্ড</title>
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
      max-width: 960px;
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
    .date-wrapper input {
      padding: 10px 16px;
      border: 1.5px solid #cbd5e1;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      color: #334155;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      background: #f8fafc;
    }
    .date-wrapper input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
      background: #fff;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 20px;
    }
    .card {
      background: #ffffff;
      padding: 28px 24px;
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
      margin-bottom: 16px;
      line-height: 1.4;
    }
    .card .count {
      font-size: 42px;
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
  </style>
</head>
<body>
  <div class="container">
    <div class="header-card">
      <div class="title-area">
        <h2>📊 স্বপন'স ওয়ার্ল্ড পেজ রিপোর্ট</h2>
        <span class="badge-live"><span class="pulse-dot"></span> লাইভ</span>
      </div>
      <div class="date-wrapper">
        <input type="date" id="datePicker" onchange="fetchReport(this.value)">
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
        <h3>৪. সিন হয়েছে কিন্তু কোনো রিপ্লাই নেই</h3>
        <div class="count" id="read_without_reply">0</div>
      </div>
    </div>
  </div>

  <script>
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('datePicker').value = today;

    async function fetchReport(date) {
      try {
        const res = await fetch('/api/daily-report?date=' + date);
        const data = await res.json();
        document.getElementById('total_received').innerText = data.stats.total_received;
        document.getElementById('total_replied').innerText = data.stats.total_replied;
        document.getElementById('unread_pending').innerText = data.stats.unread_pending;
        document.getElementById('read_without_reply').innerText = data.stats.read_without_reply;
      } catch (err) {
        console.error('Failed to load report:', err);
      }
    }
    fetchReport(today);
    setInterval(() => fetchReport(document.getElementById('datePicker').value), 5000);
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
            const stmt = db.prepare(`
              INSERT OR IGNORE INTO messages 
              (page_id, sender_id, message_id, message_text, message_time, status)
              VALUES (?, ?, ?, ?, ?, 'unread')
            `);
            stmt.run(
              pageId,
              event.sender.id,
              event.message.mid,
              event.message.text || "",
              event.timestamp
            );
          }

          // সিন ইভেন্ট
          if (event.read) {
            const customerId = event.sender.id;
            const watermark = event.read.watermark;

            db.prepare(`
              UPDATE messages 
              SET status = 'read' 
              WHERE page_id = ? AND sender_id = ? AND message_time <= ? AND status = 'unread'
            `).run(pageId, customerId, watermark);
          }

          // পেজ রিপ্লাই
          if (event.message && event.message.is_echo) {
            const customerId = event.recipient.id;

            db.prepare(`
              INSERT INTO replies 
              (page_id, sender_id, message_id, reply_text, reply_time)
              VALUES (?, ?, ?, ?, ?)
            `).run(
              pageId,
              customerId,
              event.message.mid,
              event.message.text || "",
              event.timestamp
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

// মেটা অ্যাপ ভেরিফিকেশন ও লাইভ করার জন্য প্রাইভেসি পলিসি রাউট
app.get("/privacy-policy", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Privacy Policy - Swapon's World</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; padding: 40px 20px; max-width: 750px; margin: auto; color: #1e293b; }
        h1 { font-size: 28px; margin-bottom: 8px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; }
        h2 { font-size: 20px; margin-top: 24px; margin-bottom: 8px; color: #1e293b; }
        p { margin-bottom: 16px; color: #475569; }
      </style>
    </head>
    <body>
      <h1>Privacy Policy</h1>
      <p>Last updated: November 2026</p>
      
      <h2>1. Information We Collect</h2>
      <p>Our Messenger bot application collects incoming message timestamps, basic sender IDs, and conversation volume sent to our Facebook Page to track customer service metrics and generate daily analytics reports.</p>
      
      <h2>2. Use of Information</h2>
      <p>The collected data is used exclusively to track customer message volumes, calculate reply counts, and improve communication efficiency. We do not sell, rent, or share personal user data with third-party organizations.</p>
      
      <h2>3. Data Storage & Security</h2>
      <p>All recorded operational metrics are stored securely within our private server database and are accessible only by authorized administrators.</p>
      
      <h2>4. User Rights & Data Deletion</h2>
      <p>Users may request the deletion of their message logs or data records at any time by sending a message directly to our Facebook Page administrator.</p>
      
      <h2>5. Contact Us</h2>
      <p>If you have questions or concerns regarding this policy, please reach out via our official Facebook Page.</p>
    </body>
    </html>
  `);
});

// ড্যাশবোর্ড ডেটা API
app.get("/api/daily-report", (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().slice(0, 10);

    const totalReceived = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE date(created_at, 'localtime') = ?
    `).get(targetDate).count;

    const totalReplied = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'replied' AND date(created_at, 'localtime') = ?
    `).get(targetDate).count;

    const unreadPending = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'unread' AND date(created_at, 'localtime') = ?
    `).get(targetDate).count;

    const readNoReply = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'read' AND date(created_at, 'localtime') = ?
    `).get(targetDate).count;

    res.json({
      date: targetDate,
      stats: {
        total_received: totalReceived,
        total_replied: totalReplied,
        unread_pending: unreadPending,
        read_without_reply: readNoReply
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
