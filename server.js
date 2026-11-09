const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

app.use(express.json());

// ক্লাউডে স্থায়ী ডিস্ক /data থাকলে সেখানে সেভ হবে, অন্যথায় লোকাল ফোল্ডারে
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

  -- হাজার হাজার মেসেজ এনালাইসিসের জন্য হাই-স্পিড ইনডেক্স
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(page_id, sender_id);
`);

// ড্যাশবোর্ডের মূল HTML
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <title>ডেইলি মেসেঞ্জার রিপোর্ট</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; padding: 30px; }
    .container { max-width: 900px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
    .header h2 { margin: 0; color: #1c1e21; }
    .header input { padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
    .card { background: #fff; padding: 25px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .card h3 { margin: 0 0 10px 0; font-size: 15px; color: #65676b; }
    .card .count { font-size: 36px; font-weight: 700; }
    .blue { border-top: 5px solid #1877f2; } .blue .count { color: #1877f2; }
    .green { border-top: 5px solid #42b72a; } .green .count { color: #42b72a; }
    .red { border-top: 5px solid #fa3e3e; } .red .count { color: #fa3e3e; }
    .orange { border-top: 5px solid #f79c1d; } .orange .count { color: #f79c1d; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>📊 ফেসবুক পেজ ডেইলি মেসেজ রিপোর্ট</h2>
      <input type="date" id="datePicker" onchange="fetchReport(this.value)">
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

// রুট ভিউ
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