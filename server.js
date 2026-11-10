const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

// সঠিক পেজ ম্যাপিং (উভয় আইডি সহ)
const PAGES = {
  "102803132669088": "Swapons World",
  "1133872699971391": "Swapons World", // ব্যাকআপ আইডি
  "250386238168336": "Stone Rose BD"
};

app.use(express.json());

// ক্লাউডে স্থায়ী ডিস্ক /data থাকলে সেখানে সেভ হবে, অন্যথায় লোকাল ফোল্ডারে
const dbDir = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : ".");
const dbPath = path.join(dbDir, "messenger.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// টেবিল তৈরি ও ইন্ডেক্সিং
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

// পূর্বের ডাটাবেজ থাকলে কলাম মাইগ্রেশন
try { db.exec(`ALTER TABLE messages ADD COLUMN read_time INTEGER;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN phone_number TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN is_order_confirm INTEGER DEFAULT 0;`); } catch (e) {}

// ফোন নম্বর বের করার ফাংশন
function extractPhoneNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:\+?88)?01[3-9]\d{8}\b/);
  return match ? match[0] : null;
}

// প্রিমিয়াম ডার্ক নিয়ন ড্যাশবোর্ড (Dark UI)
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ডেইলি মেসেঞ্জার ও সেলস ড্যাশবোর্ড</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Hind Siliguri', 'Plus Jakarta Sans', sans-serif;
      background-color: #0b0f17;
      background-image: 
        radial-gradient(at 10% 10%, rgba(16, 185, 129, 0.05) 0px, transparent 50%),
        radial-gradient(at 90% 90%, rgba(59, 130, 246, 0.05) 0px, transparent 50%),
        linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 30px 30px, 30px 30px;
      color: #f1f5f9;
      min-height: 100vh;
      padding: 35px 20px;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
    }
    .header-card {
      background: #111827;
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 20px 28px;
      border-radius: 20px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 25px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .title-area {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      font-size: 24px;
    }
    .header-card h2 {
      font-size: 22px;
      font-weight: 700;
      color: #f8fafc;
    }
    .badge-live {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 9999px;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      background-color: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 8px #10b981;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.8; }
      50% { transform: scale(1.3); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.8; }
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .controls select, .controls input {
      padding: 9px 14px;
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      color: #e5e7eb;
      outline: none;
      transition: all 0.2s;
    }
    .controls select:focus, .controls input:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
    }
    .card {
      background: #111827;
      border-radius: 20px;
      padding: 24px;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 165px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.05);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .card:hover {
      transform: translateY(-3px);
    }
    .card-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .card-title {
      font-size: 15px;
      font-weight: 600;
      color: #94a3b8;
    }
    .card-icon {
      font-size: 18px;
      padding: 6px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card-mid {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .card .count {
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-size: 42px;
      font-weight: 800;
      line-height: 1;
    }
    .badge-pill {
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 9999px;
    }
    .card-bottom {
      margin-top: 15px;
    }
    .progress-bar-bg {
      background: #1f2937;
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.5s ease;
    }
    .sparkline-svg {
      width: 100%;
      height: 28px;
      overflow: visible;
    }

    /* থিম ভ্যারিয়েন্ট গ্লো ও নিয়ন ইফেক্ট */
    .card-blue { border-color: rgba(59, 130, 246, 0.3); }
    .card-blue .count { color: #60a5fa; text-shadow: 0 0 20px rgba(59, 130, 246, 0.4); }
    .card-blue .card-icon { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
    .card-blue .badge-pill { background: rgba(59, 130, 246, 0.15); color: #93c5fd; }

    .card-green { border-color: rgba(16, 185, 129, 0.3); }
    .card-green .count { color: #34d399; text-shadow: 0 0 20px rgba(16, 185, 129, 0.4); }
    .card-green .card-icon { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .card-green .progress-bar-fill { background: #10b981; box-shadow: 0 0 10px #10b981; }

    .card-red { border-color: rgba(239, 68, 68, 0.3); }
    .card-red .count { color: #f87171; text-shadow: 0 0 20px rgba(239, 68, 68, 0.4); }
    .card-red .card-icon { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .card-red .badge-pill { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }

    .card-orange { border-color: rgba(245, 158, 11, 0.3); }
    .card-orange .count { color: #fbbf24; text-shadow: 0 0 20px rgba(245, 158, 11, 0.4); }
    .card-orange .card-icon { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .card-orange .badge-pill { background: rgba(245, 158, 11, 0.15); color: #fcd34d; }

    .card-purple { border-color: rgba(168, 85, 247, 0.3); }
    .card-purple .count { color: #c084fc; text-shadow: 0 0 20px rgba(168, 85, 247, 0.4); }
    .card-purple .card-icon { background: rgba(168, 85, 247, 0.15); color: #c084fc; }
    .card-purple .badge-pill { background: rgba(168, 85, 247, 0.15); color: #e9d5ff; }

    .card-teal { border-color: rgba(20, 184, 166, 0.3); }
    .card-teal .count { color: #2dd4bf; text-shadow: 0 0 20px rgba(20, 184, 166, 0.4); }
    .card-teal .card-icon { background: rgba(20, 184, 166, 0.15); color: #2dd4bf; }
    .card-teal .badge-pill { background: rgba(20, 184, 166, 0.15); color: #99f6e4; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-card">
      <div class="title-area">
        <span class="brand-icon">📊</span>
        <h2 id="dashboardTitle">সব পেজ (একসাথে) রিপোর্ট</h2>
        <span class="badge-live"><span class="pulse-dot"></span> লাইভ</span>
      </div>
      <div class="controls">
        <select id="pagePicker" onchange="fetchReport()">
          <option value="all">সব পেজ (একসাথে)</option>
          <option value="102803132669088">Swapons World</option>
          <option value="250386238168336">Stone Rose BD</option>
        </select>
        <input type="date" id="datePicker" onchange="fetchReport()">
      </div>
    </div>
    
    <div class="grid">
      <!-- ১. মোট কাস্টমার মেসেজ -->
      <div class="card card-blue">
        <div class="card-top">
          <span class="card-title">১. মোট কাস্টমার মেসেজ এসেছে</span>
          <div class="card-icon">💬</div>
        </div>
        <div class="card-mid">
          <div class="count" id="total_received">0</div>
          <span class="badge-pill">১০০% ভলিউম</span>
        </div>
        <div class="card-bottom">
          <svg class="sparkline-svg" viewBox="0 0 100 25" preserveAspectRatio="none">
            <path d="M0,20 Q20,5 40,15 T80,8 T100,2" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
        </div>
      </div>

      <!-- ২. উত্তর দেওয়া সম্পন্ন -->
      <div class="card card-green">
        <div class="card-top">
          <span class="card-title">২. উত্তর দেওয়া সম্পন্ন হয়েছে</span>
          <div class="card-icon">✓</div>
        </div>
        <div class="card-mid">
          <div class="count" id="total_replied">0</div>
          <span class="card-title" id="reply_percentage" style="font-size: 13px; color: #34d399;">০% রেসপন্স রেট</span>
        </div>
        <div class="card-bottom">
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" id="reply_progress" style="width: 0%;"></div>
          </div>
        </div>
      </div>

      <!-- ৩. দেখা হয়নি -->
      <div class="card card-red">
        <div class="card-top">
          <span class="card-title">৩. দেখা হয়নি (Unread / বাকি)</span>
          <div class="card-icon">⏳</div>
        </div>
        <div class="card-mid">
          <div class="count" id="unread_pending">0</div>
          <span class="badge-pill">অ্যাকশন দরকার</span>
        </div>
        <div class="card-bottom">
          <svg class="sparkline-svg" viewBox="0 0 100 25" preserveAspectRatio="none">
            <path d="M0,18 Q25,22 50,12 T80,18 T100,5" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
        </div>
      </div>

      <!-- ৪. সিন হয়েছে কিন্তু রিপ্লাই নেই -->
      <div class="card card-orange">
        <div class="card-top">
          <span class="card-title">৪. সিন হয়েছে কিন্তু ২ মিনিটে রিপ্লাই নেই ⚠️</span>
          <div class="card-icon">⚡</div>
        </div>
        <div class="card-mid">
          <div class="count" id="read_without_reply">0</div>
          <span class="badge-pill">লেট রিপ্লাই</span>
        </div>
        <div class="card-bottom">
          <svg class="sparkline-svg" viewBox="0 0 100 25" preserveAspectRatio="none">
            <path d="M0,22 Q30,10 60,18 T100,8" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
        </div>
      </div>

      <!-- ৫. কনফার্ম অর্ডার -->
      <div class="card card-purple">
        <div class="card-top">
          <span class="card-title">৫. কনফার্ম অর্ডার (Your order confirm)</span>
          <div class="card-icon">📦</div>
        </div>
        <div class="card-mid">
          <div class="count" id="total_confirmed_orders">0</div>
          <span class="badge-pill" id="order_percentage">০% কনভার্শন</span>
        </div>
        <div class="card-bottom">
          <svg class="sparkline-svg" viewBox="0 0 100 25" preserveAspectRatio="none">
            <path d="M0,20 Q20,15 40,22 T70,5 T100,10" fill="none" stroke="#a855f7" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
        </div>
      </div>

      <!-- ৬. ফোন নম্বর -->
      <div class="card card-teal">
        <div class="card-top">
          <span class="card-title">৬. ফোন নম্বর এসেছে (ইউনিক কাস্টমার)</span>
          <div class="card-icon">📞</div>
        </div>
        <div class="card-mid">
          <div class="count" id="total_phone_numbers">0</div>
          <span class="badge-pill">লিড</span>
        </div>
        <div class="card-bottom">
          <svg class="sparkline-svg" viewBox="0 0 100 25" preserveAspectRatio="none">
            <path d="M0,15 Q30,22 60,5 T100,12" fill="none" stroke="#14b8a6" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
        </div>
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
        
        document.getElementById('dashboardTitle').innerText = selectedText + ' রিপোর্ট';

        let url = '/api/daily-report?date=' + date;
        if (pageId && pageId !== 'all') {
          url += '&page_id=' + pageId;
        }

        const res = await fetch(url);
        const data = await res.json();
        
        const total = data.stats.total_received || 0;
        const replied = data.stats.total_replied || 0;
        const orders = data.stats.total_confirmed_orders || 0;

        document.getElementById('total_received').innerText = total;
        document.getElementById('total_replied').innerText = replied;
        document.getElementById('unread_pending').innerText = data.stats.unread_pending;
        document.getElementById('read_without_reply').innerText = data.stats.read_without_reply;
        document.getElementById('total_confirmed_orders').innerText = orders;
        document.getElementById('total_phone_numbers').innerText = data.stats.total_phone_numbers;

        // রেসপন্স রেট ও প্রগ্রেস বার ক্যালকুলেশন
        const replyRate = total > 0 ? ((replied / total) * 100).toFixed(1) : 0;
        document.getElementById('reply_percentage').innerText = replyRate + '% রেসপন্স রেট';
        document.getElementById('reply_progress').style.width = Math.min(replyRate, 100) + '%';

        // কনভার্শন রেট ক্যালকুলেশন
        const orderRate = total > 0 ? ((orders / total) * 100).toFixed(1) : 0;
        document.getElementById('order_percentage').innerText = orderRate + '% কনভার্শন';

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

          // সিন ইভেন্ট
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

// প্রাইভেসি পলিসি
app.get("/privacy-policy", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Privacy Policy</title>
      <style>body { font-family: sans-serif; line-height: 1.6; padding: 40px; color: #333; }</style>
    </head>
    <body>
      <h1>Privacy Policy</h1>
      <p>Last updated: November 2026</p>
      <p>This application collects message metrics and analytics for connected Facebook pages.</p>
    </body>
    </html>
  `);
});

// সক্রিয় সব পেজের তালিকা
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

    // Swapons World পেজের উভয় আইডি হ্যান্ডেল করার লজিক
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

    // ৪. সিন হয়েছে কিন্তু ২ মিনিটে রিপ্লাই নেই (120,000 ms)
    const twoMinutesAgo = Date.now() - (2 * 60 * 1000);
    let readParams = [targetDate, twoMinutesAgo];
    if (targetPage && targetPage !== "all" && targetPage !== "102803132669088" && targetPage !== "1133872699971391") {
      readParams.push(targetPage);
    }

    const readNoReply = db.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE status = 'read' 
      AND date(created_at, 'localtime') = ? 
      AND (read_time IS NULL OR read_time <= ?)
      ${pageFilter}
    `).get(...readParams).count;

    // ৫. কনফার্ম অর্ডার
    const orderConfirms = db.prepare(`
      SELECT COUNT(*) as count FROM replies 
      WHERE is_order_confirm = 1 AND date(created_at, 'localtime') = ? ${pageFilter}
    `).get(...params).count;

    // ৬. ফোন নম্বর
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
