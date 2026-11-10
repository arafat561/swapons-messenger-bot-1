const express = require("express");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

// সঠিক পেজ ম্যাপিং
const PAGES = {
  "102803132669088": "Swapons World",
  "1133872699971391": "Swapons World", // ব্যাকআপ আইডি
  "250386238168336": "Stone Rose BD"
};

// মডারেটরদের স্বাগতম মেসেজ ও নাম কনফিগারেশন
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

// টেক্সট থেকে মডারেটর খোঁজার ফাংশন
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

// ডাটাবেস পাথ নির্ধারণ
const dbDir = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : ".");
const dbPath = path.join(dbDir, "messenger.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// টেবিল ইনিশিয়ালাইজেশন
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

// মাইগ্রেশন হ্যান্ডলিং
try { db.exec(`ALTER TABLE messages ADD COLUMN read_time INTEGER;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN phone_number TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN assigned_moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN is_order_confirm INTEGER DEFAULT 0;`); } catch (e) {}

// ফোন নম্বর বের করার ফাংশন
function extractPhoneNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:\+?88)?01[3-9]\d{8}\b/);
  return match ? match[0] : null;
}

// প্রিমিয়াম ডার্ক নিয়ন ড্যাশবোর্ড (HTML + CSS + JS)
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
    .container { max-width: 1100px; margin: 0 auto; }
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
    .title-area { display: flex; align-items: center; gap: 12px; }
    .header-card h2 { font-size: 22px; font-weight: 700; color: #f8fafc; }
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
      width: 7px; height: 7px;
      background-color: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 8px #10b981;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0% { opacity: 0.8; } 50% { opacity: 1; transform: scale(1.2); } 100% { opacity: 0.8; } }
    .controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .controls select, .controls input {
      padding: 9px 14px;
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      color: #e5e7eb;
      outline: none;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .card {
      background: #111827;
      border-radius: 20px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 165px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.05);
      transition: transform 0.2s ease;
    }
    .card:hover { transform: translateY(-3px); }
    .card-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
