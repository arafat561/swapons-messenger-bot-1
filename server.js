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
const DAY_R_CREATED = "date(r.created_at, '+6 hours')";
const DAY_R_TIME = "date((r.reply_time / 1000), 'unixepoch', '+6 hours')";
const DAY_R = `CASE WHEN r.reply_time IS NOT NULL AND r.reply_time > 0 THEN ${DAY_R_TIME} ELSE ${DAY_R_CREATED} END`;

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
  { id: "act_846240430355170", name: "Swapons World-3", brand: "swapons" },
  { id: "act_414594386485433", name: "Swapons World-2", brand: "swapons" },
  { id: "act_705111815068714", name: "ZXC19 (Stone rose)", brand: "swapons" },
  { id: "act_412119051932043", name: "ST-18 (Stone Rose)", brand: "swapons" },
  { id: "act_7707351539304206", name: "ZXC20 (Stone Rose)", brand: "swapons" },
  { id: "act_770104971706610", name: "ST-09 (Stone Rose)", brand: "swapons" },
  { id: "act_722336793300354", name: "ST-07 (Stone Rose)", brand: "stone" },
  { id: "act_3681717408727534", name: "ST-10 (Stone Rose)", brand: "stone" }
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

const MODERATORS = [
  {
    name: "mony",
    fb_link: "https://www.facebook.com/profile.php?id=61594030833722",
    aliases: ["61594030833722"]
  },
  {
    name: "shuvro",
    fb_link: "https://www.facebook.com/profile.php?id=61594801244167",
    aliases: ["61594801244167"]
  },
  {
    name: "shihab",
    fb_link: "https://www.facebook.com/share/19iBuYADbj/?mibextid=wwXIfr",
    aliases: ["19iBuYADbj"]
  },
  {
    name: "Faria",
    fb_link: "https://www.facebook.com/faria.rahman.800321",
    aliases: ["faria.rahman.800321"]
  },
  {
    name: "Sanjana",
    fb_link: "https://www.facebook.com/share/1PHGk91SEz/",
    aliases: ["1PHGk91SEz"]
  },
  {
    name: "ashraful",
    fb_link: "https://www.facebook.com/profile.php?id=61592130331098&sk=about",
    aliases: ["61592130331098"]
  },
  {
    name: "tania",
    fb_link: "https://www.facebook.com/profile.php?id=61591664456446",
    aliases: ["61591664456446"]
  },
  {
    name: "eram",
    fb_link: "https://www.facebook.com/share/1CRG2mozpQ/",
    aliases: ["1CRG2mozpQ"]
  },
  {
    name: "fahim",
    fb_link: "https://www.facebook.com/ferdous.fahim.921",
    aliases: ["ferdous.fahim.921"]
  },
  {
    name: "jaber",
    fb_link: "https://www.facebook.com/share/19kYfdY2fr/",
    aliases: ["19kYfdY2fr"]
  },
  {
    name: "apon",
    fb_link: "https://www.facebook.com/profile.php?id=61593951013042&mibextid=ZbWKwL",
    aliases: ["61593951013042"]
  },
  {
    name: "rifat",
    fb_link: "https://www.facebook.com/profile.php?id=61594203401850",
    aliases: ["61594203401850"]
  },
  {
    name: "halim",
    fb_link: "https://www.facebook.com/profile.php?id=61594028540149",
    aliases: ["61594028540149"]
  },
  {
    name: "farjana",
    fb_link: "https://www.facebook.com/share/1PoAchCNQh/",
    aliases: ["1PoAchCNQh"]
  },
  {
    name: "apurbo",
    fb_link: "https://www.facebook.com/profile.php?id=61592804760356",
    aliases: ["61592804760356"]
  },
  {
    name: "ruman",
    fb_link: "https://www.facebook.com/ruman.hossen.342329",
    aliases: ["ruman.hossen.342329"]
  },
  {
    name: "saidul",
    fb_link: "https://www.facebook.com/profile.php?id=61592488485671",
    aliases: ["61592488485671"]
  }
];

function extractFbIdentifier(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s.length > 140) return null;

  const idQuery = s.match(/[?&]id=(\d{5,})/i);
  if (idQuery) return idQuery[1];

  const sharePath = s.match(/facebook\.com\/share\/([A-Za-z0-9_-]+)/i);
  if (sharePath) return sharePath[1];

  const userPath = s.match(/facebook\.com\/([A-Za-z0-9._-]+)\/?(?:\?|$)/i);
  if (userPath && userPath[1].toLowerCase() !== "profile.php") {
    return userPath[1];
  }

  const fbIdPrefix = s.match(/^(?:FB ID|FB Share):\s*([A-Za-z0-9._-]+)$/i);
  if (fbIdPrefix) return fbIdPrefix[1].trim();

  return s;
}

const FB_LINK_TO_MODERATOR = new Map();
for (const mod of MODERATORS) {
  const keys = [mod.name, mod.fb_link, ...(mod.aliases || [])];
  for (const k of keys) {
    if (!k) continue;
    const rawKey = String(k).trim();
    const extracted = extractFbIdentifier(rawKey);
    FB_LINK_TO_MODERATOR.set(rawKey.toLowerCase(), mod.name);
    if (extracted) {
      FB_LINK_TO_MODERATOR.set(extracted.toLowerCase(), mod.name);
    }
  }
}

function detectModeratorByFbLink(rawOrText) {
  if (!rawOrText) return null;
  const str = String(rawOrText).trim();
  if (!str) return null;
  const lower = str.toLowerCase();

  if (FB_LINK_TO_MODERATOR.has(lower)) {
    return FB_LINK_TO_MODERATOR.get(lower);
  }

  const extracted = extractFbIdentifier(str);
  if (extracted && FB_LINK_TO_MODERATOR.has(extracted.toLowerCase())) {
    return FB_LINK_TO_MODERATOR.get(extracted.toLowerCase());
  }

  for (const mod of MODERATORS) {
    const linkId = extractFbIdentifier(mod.fb_link);
    if (linkId && lower.includes(linkId.toLowerCase())) {
      return mod.name;
    }
    if (mod.fb_link && lower.includes(mod.fb_link.toLowerCase())) {
      return mod.name;
    }
  }

  return null;
}

function normalizeModeratorName(rawMod) {
  if (!rawMod) return null;
  const trimmed = String(rawMod).trim();
  if (!trimmed) return null;
  return detectModeratorByFbLink(trimmed) || trimmed;
}

app.use(express.json({ limit: "15mb" }));

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
  CREATE INDEX IF NOT EXISTS idx_replies_sender ON replies(page_id, sender_id);
  CREATE INDEX IF NOT EXISTS idx_replies_created_at ON replies(created_at);
  CREATE INDEX IF NOT EXISTS idx_assign_day ON moderator_assignments(day);
`);

try { db.exec(`ALTER TABLE messages ADD COLUMN read_time INTEGER;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN phone_number TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN assigned_moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN image_url TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN ad_info TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN moderator TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN is_order_confirm INTEGER DEFAULT 0;`); } catch (e) {}
try { db.exec(`ALTER TABLE replies ADD COLUMN image_url TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE customers ADD COLUMN ad_info TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE customers ADD COLUMN profile_pic TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE moderator_assignments ADD COLUMN bucket TEXT DEFAULT 'pending';`); } catch (e) {}

try {
  db.prepare(`UPDATE customers SET ad_info = NULL WHERE ad_info LIKE '%39178562_1505197616293642%'`).run();
  db.prepare(`UPDATE messages SET ad_info = NULL WHERE ad_info LIKE '%39178562_1505197616293642%'`).run();
} catch (e) {}

function isBlockedStickerUrl(url) {
  if (!url) return false;
  const u = String(url);
  return u.includes("39178562_1505197616293642") || u.includes("/stickers/");
}

function isValidProductAttachment(att) {
  if (!att) return null;
  if (att.mime_type && String(att.mime_type).includes("sticker")) return null;
  const imgData = att.image_data || {};
  const imgUrl = imgData.url || att.file_url || "";
  if (!imgUrl || isBlockedStickerUrl(imgUrl)) return null;

  const w = Number(imgData.width || 0);
  const h = Number(imgData.height || 0);
  if ((w > 0 && w <= 120) || (h > 0 && h <= 120)) return null;

  return imgUrl;
}

const stmts = {
  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages
    (page_id, sender_id, message_id, message_text, image_url, ad_info, message_time, phone_number, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread')
  `),
  markRead: db.prepare(`
    UPDATE messages
    SET status = 'read', read_time = ?
    WHERE page_id = ? AND sender_id = ? AND message_time <= ? AND status = 'unread'
  `),
  insertReply: db.prepare(`
    INSERT INTO replies
    (page_id, sender_id, message_id, reply_text, image_url, reply_time, moderator, is_order_confirm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  assignModerator: db.prepare(`
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

function extractPhoneNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:\+?88)?01[3-9]\d{8}\b/);
  return match ? match[0] : null;
}

const fbAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

function sendFacebookPayload(pageId, bodyObj) {
  return new Promise((resolve, reject) => {
    const token = getPageToken(pageId);
    if (!token) {
      return reject(new Error(`Page ID (${pageId}) এর জন্য Railway Variables-এ SWAPONS_WORLD_PAGE_TOKEN বা STONE_ROSE_PAGE_TOKEN সেট করা নেই!`));
    }

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

async function syncCustomerAndAdFromGraph(pageId, senderId) {
  const token = getPageToken(pageId);
  if (!token) return null;

  try {
    const existing = db.prepare(`SELECT name, profile_pic, ad_info FROM customers WHERE page_id = ? AND sender_id = ?`).get(pageId, senderId);
    let fullName = (existing && existing.name && !existing.name.startsWith("Customer_")) ? existing.name : "";
    let picUrl = (existing && existing.profile_pic) ? existing.profile_pic : "";

    let parsedExistingAd = null;
    if (existing && existing.ad_info) {
      try {
        const tmp = JSON.parse(existing.ad_info);
        if (tmp && !isBlockedStickerUrl(tmp.photo_url) && !isBlockedStickerUrl(tmp.post_url)) {
          parsedExistingAd = tmp;
        }
      } catch (e) {}
    }

    if (!fullName || !picUrl) {
      const profile = await httpsGetJson(`https://graph.facebook.com/${META_API_VERSION}/${senderId}?fields=first_name,last_name,name,profile_pic&access_token=${token}`);
      if (profile && !profile.error) {
        if (profile.name || profile.first_name) {
          fullName = profile.name || `${profile.first_name || ""} ${profile.last_name || ""}`.trim();
        }
        if (profile.profile_pic) {
          picUrl = profile.profile_pic;
        }
      }
    }

    const convUrl = `https://graph.facebook.com/${META_API_VERSION}/me/conversations?user_id=${senderId}&fields=participants,messages.limit(8){message,attachments,sticker,from}&access_token=${token}`;
    const conv = await httpsGetJson(convUrl);
    if (conv && conv.data && conv.data[0]) {
      const thread = conv.data[0];

      if (!fullName && thread.participants && thread.participants.data) {
        const custPart = thread.participants.data.find((p) => String(p.id) === String(senderId));
        if (custPart && custPart.name) {
          fullName = custPart.name;
        }
      }

      if (!parsedExistingAd && thread.messages && thread.messages.data) {
        for (const m of thread.messages.data) {
          if (m.sticker) continue;
          if (m.attachments && m.attachments.data && m.attachments.data.length > 0 && m.from && String(m.from.id) === String(senderId)) {
            const validImg = isValidProductAttachment(m.attachments.data[0]);
            if (validImg) {
              const adObj = {
                ad_id: "",
                ad_title: m.message || "Customer Sent Product Photo",
                post_url: validImg,
                photo_url: validImg
              };
              db.prepare(`
                INSERT INTO customers (page_id, sender_id, name, profile_pic, ad_info) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(page_id, sender_id) DO UPDATE SET 
                  name = COALESCE(NULLIF(excluded.name, ''), customers.name),
                  profile_pic = COALESCE(NULLIF(excluded.profile_pic, ''), customers.profile_pic),
                  ad_info = excluded.ad_info
              `).run(pageId, senderId, fullName || `Customer_${senderId.slice(-4)}`, picUrl, JSON.stringify(adObj));
              return adObj;
            }
          }
        }
      }
    }

    if (fullName || picUrl) {
      db.prepare(`
        INSERT INTO customers (page_id, sender_id, name, profile_pic) VALUES (?, ?, ?, ?)
        ON CONFLICT(page_id, sender_id) DO UPDATE SET 
          name = COALESCE(NULLIF(excluded.name, ''), customers.name),
          profile_pic = COALESCE(NULLIF(excluded.profile_pic, ''), customers.profile_pic)
      `).run(pageId, senderId, fullName || `Customer_${senderId.slice(-4)}`, picUrl);
    }

    return parsedExistingAd;
  } catch (e) {}
  return null;
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

function requireModAuth(req, res, next) {
  const modPass = req.headers["x-mod-pass"];
  if (modPass === MOD_PASS || modPass === DASHBOARD_PASS || modPass === "swapon123") {
    return next();
  }
  return res.status(401).json({ error: "ভুল মডারেটর পাসওয়ার্ড!" });
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/inbox", (req, res) => {
  res.sendFile(path.join(__dirname, "inbox.html"));
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

async function resolveEchoModeratorByFbLink(pageId, customerId, event) {
  if (event.message && event.message.from && String(event.message.from.id) !== String(pageId)) {
    const fromIdMatch = detectModeratorByFbLink(event.message.from.id);
    if (fromIdMatch) return fromIdMatch;
    if (event.message.from.name) {
      const fromNameMatch = detectModeratorByFbLink(event.message.from.name);
      if (fromNameMatch) return fromNameMatch;
    }
  }

  const token = getPageToken(pageId);
  if (token && event.message && event.message.mid) {
    try {
      const msgUrl = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(event.message.mid)}?fields=from&access_token=${encodeURIComponent(token)}`;
      const msgInfo = await httpsGetJson(msgUrl);
      if (msgInfo && msgInfo.from && String(msgInfo.from.id) !== String(pageId)) {
        const matchById = detectModeratorByFbLink(msgInfo.from.id);
        if (matchById) return matchById;
        if (msgInfo.from.name) {
          const matchByName = detectModeratorByFbLink(msgInfo.from.name);
          if (matchByName) return matchByName;
        }
      }
    } catch (e) {}
  }

  return null;
}

async function handleMessagingEvent(pageId, event) {
  const today = dhakaDate();
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

    stmts.insertMessage.run(
      pageId,
      senderId,
      event.message.mid,
      displayText,
      imageUrl,
      adInfoJson,
      event.timestamp,
      extractPhoneNumber(rawText)
    );

    db.prepare(`
      UPDATE moderator_assignments SET bucket = 'pending'
      WHERE page_id = ? AND sender_id = ? AND day = ? AND bucket != 'pending'
    `).run(pageId, senderId, today);

    syncCustomerAndAdFromGraph(pageId, senderId).catch(() => {});
    return;
  }

  if (event.postback || event.referral) {
    const ts = event.timestamp || Date.now();
    const mid = (event.postback && event.postback.mid) || `ref_${senderId}_${ts}`;
    const text = (event.postback && (event.postback.title || event.postback.payload)) || "📢 Ad থেকে ইনবক্সে এসেছেন";
    stmts.insertMessage.run(pageId, senderId, mid, text, null, adInfoJson, ts, extractPhoneNumber(text));
    syncCustomerAndAdFromGraph(pageId, senderId).catch(() => {});
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

    const replyTime = event.timestamp || Date.now();
    const replyDay = dhakaDate(replyTime);
    const isConfirm = replyText.toLowerCase().includes("your order confirm") ? 1 : 0;
    const mod = await resolveEchoModeratorByFbLink(pageId, customerId, event);

    const exists = db.prepare(`SELECT id FROM replies WHERE message_id = ?`).get(event.message.mid);
    if (!exists) {
      stmts.insertReply.run(pageId, customerId, event.message.mid, replyText || (replyImg ? "[ছবি]" : "👍"), replyImg, replyTime, mod, isConfirm);
    }

    if (mod) stmts.assignModerator.run(pageId, customerId, replyDay, mod, replyTime);
    stmts.markReplied.run(pageId, customerId, replyDay);
    return;
  }

  if (event.read) {
    stmts.markRead.run(Date.now(), pageId, senderId, event.read.watermark);
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

app.get("/api/mod/list", (req, res) => {
  res.json({ moderators: MODERATORS.map((m) => m.name) });
});

app.post("/api/mod/batch", requireModAuth, async (req, res) => {
  try {
    const { moderator, requestNew, pageFilter, bucket } = req.body;
    if (!moderator) return res.status(400).json({ error: "Moderator name required" });

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
      `).all(today, moderator, targetBucket, today, ...pcM.params);
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
          stmts.assignModerator.run(item.page_id, item.sender_id, today, moderator, now);
        }
      });
      assignTransaction(unassignedCustomers);

      pendingQueue = getBucketCustomers("pending");
    }

    let currentList = activeBucket === "pending" ? pendingQueue : getBucketCustomers(activeBucket);

    const missingProfiles = currentList.filter(
      (q) => !q.profile_pic || q.customer_name.startsWith("Customer_")
    );
    if (missingProfiles.length > 0) {
      Promise.all(
        missingProfiles.slice(0, 5).map((q) => syncCustomerAndAdFromGraph(q.page_id, q.sender_id))
      ).catch(() => {});
    }

    const countRows = db.prepare(`
      SELECT COALESCE(NULLIF(a.bucket, ''), 'pending') as b, COUNT(DISTINCT a.page_id || ':' || a.sender_id) as cnt
      FROM moderator_assignments a
      JOIN messages m ON m.page_id = a.page_id AND m.sender_id = a.sender_id AND ${DAY_M} = ?
      WHERE a.day = ? AND a.moderator = ? ${pcM.sql}
      GROUP BY b
    `).all(today, today, moderator, ...pcM.params);

    const counts = { pending: 0, average: 0, good: 0, poor: 0 };
    countRows.forEach((r) => {
      if (counts[r.b] !== undefined) counts[r.b] = r.cnt;
    });

    const globalUnassigned = db.prepare(`
      SELECT COUNT(DISTINCT m.page_id || ':' || m.sender_id) as count
      FROM messages m
      LEFT JOIN moderator_assignments a 
        ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
      WHERE a.moderator IS NULL
        AND m.status != 'replied'
        AND ${DAY_M} = ?
        ${pcM.sql}
    `).get(today, today, ...pcM.params).count;

    res.json({
      moderator,
      bucket: activeBucket,
      counts,
      queue: currentList.map((q) => {
        let parsedAd = null;
        if (q.ad_info) {
          try {
            const tmp = JSON.parse(q.ad_info);
            if (tmp && !isBlockedStickerUrl(tmp.photo_url) && !isBlockedStickerUrl(tmp.post_url)) {
              parsedAd = tmp;
            }
          } catch (e) {}
        }
        return {
          ...q,
          ad_data: parsedAd,
          page_name: PAGE_NAMES[q.page_id] || "Page"
        };
      }),
      global_unassigned: globalUnassigned
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mod/classify", requireModAuth, (req, res) => {
  try {
    const { page_id, sender_id, moderator, bucket } = req.body;
    if (!page_id || !sender_id || !moderator || !["pending", "average", "good", "poor"].includes(bucket)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const today = dhakaDate();
    const now = Date.now();

    db.prepare(`
      INSERT INTO moderator_assignments (page_id, sender_id, day, moderator, assigned_at, bucket)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(page_id, sender_id, day) DO UPDATE SET moderator = excluded.moderator, bucket = excluded.bucket
    `).run(page_id, sender_id, today, moderator, now, bucket);

    res.json({ success: true, bucket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/mod/chat", requireModAuth, async (req, res) => {
  try {
    const { page_id, sender_id } = req.query;

    const incoming = db.prepare(`
      SELECT 'customer' as sender, COALESCE(NULLIF(message_text, ''), '👍') as text, image_url, ad_info, message_time as time
      FROM messages
      WHERE page_id = ? AND sender_id = ?
    `).all(page_id, sender_id);

    const outgoing = db.prepare(`
      SELECT 'page' as sender, COALESCE(NULLIF(reply_text, ''), '👍') as text, image_url, reply_time as time, moderator
      FROM replies
      WHERE page_id = ? AND sender_id = ?
    `).all(page_id, sender_id);

    let custRow = db.prepare(`SELECT name, profile_pic, ad_info FROM customers WHERE page_id = ? AND sender_id = ?`).get(page_id, sender_id);
    let adData = null;
    const rawAd = (custRow && custRow.ad_info) || (incoming.find((i) => i.ad_info) || {}).ad_info;
    if (rawAd) {
      try {
        const tmp = JSON.parse(rawAd);
        if (tmp && !isBlockedStickerUrl(tmp.photo_url) && !isBlockedStickerUrl(tmp.post_url)) {
          adData = tmp;
        }
      } catch (e) {}
    }

    if (!adData || !custRow || !custRow.profile_pic) {
      syncCustomerAndAdFromGraph(page_id, sender_id).catch(() => {});
    }

    const merged = [...incoming, ...outgoing].sort((a, b) => (a.time || 0) - (b.time || 0));
    res.json({
      messages: merged,
      ad_data: adData,
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
    const { page_id, sender_id, text, imageBase64, moderator } = req.body;
    if (!page_id || !sender_id || !moderator || (!text && !imageBase64)) {
      return res.status(400).json({ error: "মেসেজ অথবা ছবি দিন" });
    }

    const now = Date.now();
    const today = dhakaDate();
    let savedImageUrl = null;
    const mid = `mod_${now}_${crypto.randomBytes(3).toString("hex")}`;

    if (imageBase64) {
      const match = imageBase64.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: "Invalid image format" });

      const ext = match[1].split("/")[1].replace("jpeg", "jpg");
      const filename = `img_${now}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
      fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(match[2], "base64"));

      const host = req.get("host");
      const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
      savedImageUrl = `${protocol}://${host}/uploads/${filename}`;
    }

    const cleanText = (text || "").trim();
    const normMod = normalizeModeratorName(moderator) || moderator;
    const isConfirm = cleanText.toLowerCase().includes("your order confirm") ? 1 : 0;

    stmts.insertReply.run(
      page_id,
      sender_id,
      mid,
      cleanText || "[ছবি পাঠানো হয়েছে]",
      savedImageUrl,
      now,
      normMod,
      isConfirm
    );
    stmts.assignModerator.run(page_id, sender_id, today, normMod, now);
    stmts.markReplied.run(page_id, sender_id, today);

    if (savedImageUrl) {
      await sendFacebookPayload(page_id, {
        recipient: { id: sender_id },
        message: {
          attachment: {
            type: "image",
            payload: { url: savedImageUrl, is_reusable: true }
          }
        },
        messaging_type: "RESPONSE"
      });
    }

    if (cleanText) {
      await sendFacebookPayload(page_id, {
        recipient: { id: sender_id },
        message: { text: cleanText },
        messaging_type: "RESPONSE"
      });
    }

    res.json({ success: true, message_id: mid, image_url: savedImageUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Meta Ads                                                            */
/* ------------------------------------------------------------------ */
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
        fields: "campaign_id,campaign_name,objective,spend,actions",
        time_range: JSON.stringify({ since: targetDate, until: targetDate }),
        use_unified_attribution_setting: "true",
        limit: "500"
      });
      const url = `https://graph.facebook.com/${META_API_VERSION}/${cleanId}/insights?${params.toString()}`;

      const accInfoParams = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        fields: "spend_cap,amount_spent,balance,account_status"
      });
      const accInfoUrl = `https://graph.facebook.com/${META_API_VERSION}/${cleanId}?${accInfoParams.toString()}`;

      const [{ rows, error }, accInfo, campRes] = await Promise.all([
        fetchAllInsights(url),
        httpsGetJson(accInfoUrl),
        httpsGetJson(
          `https://graph.facebook.com/${META_API_VERSION}/${cleanId}/campaigns?${new URLSearchParams({
            access_token: META_ACCESS_TOKEN,
            fields: "id,status",
            limit: "500"
          }).toString()}`
        )
      ]);

      const statusMap = new Map();
      if (campRes && Array.isArray(campRes.data)) {
        campRes.data.forEach((c) => {
          if (c && c.id) statusMap.set(String(c.id), String(c.status || "ACTIVE").toUpperCase());
        });
      }

      let hasSpendCap = false;
      let remainingUsd = null;
      let spendCapUsd = 0;
      let amountSpentUsd = 0;
      let balanceDueUsd = 0;

      if (accInfo && !accInfo.error) {
        const rawCap = Number(accInfo.spend_cap || 0);
        const rawSpent = Number(accInfo.amount_spent || 0);
        const rawBal = Number(accInfo.balance || 0);

        spendCapUsd = rawCap > 0 ? rawCap / 100 : 0;
        amountSpentUsd = rawSpent > 0 ? rawSpent / 100 : 0;
        balanceDueUsd = rawBal > 0 ? rawBal / 100 : 0;

        if (rawCap > 0) {
          hasSpendCap = true;
          remainingUsd = Math.max(0, (rawCap - rawSpent) / 100);
        }
      }

      let totalSpend = 0;
      let totalMessages = 0;
      let totalOrders = 0;
      let msgSpend = 0;
      let salesSpend = 0;
      const campaignList = [];

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

        let cMsgSpend = 0;
        let cSalesSpend = 0;

        if (campMsgs > 0 && campOrders === 0) {
          cMsgSpend = campSpend;
        } else if (campOrders > 0 && campMsgs === 0) {
          cSalesSpend = campSpend;
        } else if (isMsgObj && !isSalesObj) {
          cMsgSpend = campSpend;
        } else if (isSalesObj && !isMsgObj) {
          cSalesSpend = campSpend;
        } else {
          if (campMsgs > 0) cMsgSpend = campSpend / 2;
          if (campOrders > 0) cSalesSpend = campSpend / 2;
        }

        msgSpend += cMsgSpend;
        salesSpend += cSalesSpend;

        const cCostPerMsg =
          campMsgs > 0 && cMsgSpend > 0 ? ((cMsgSpend / campMsgs) * 100).toFixed(1) : "0.0";
        const cCostPerOrder =
          campOrders > 0 && cSalesSpend > 0 ? (cSalesSpend / campOrders).toFixed(2) : "0.00";

        const campIdStr = String(camp.campaign_id || "");
        campaignList.push({
          id: campIdStr,
          name: camp.campaign_name || "Unnamed Ad Campaign",
          objective: camp.objective || "",
          status: statusMap.get(campIdStr) || "ACTIVE",
          spend: campSpend.toFixed(2),
          messages: campMsgs,
          msg_spend: cMsgSpend.toFixed(2),
          cost_per_msg_cents: cCostPerMsg,
          orders: campOrders,
          sales_spend: cSalesSpend.toFixed(2),
          cost_per_order_usd: cCostPerOrder
        });
      });

      campaignList.sort((a, b) => parseFloat(b.spend) - parseFloat(a.spend));

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
        has_spend_cap: hasSpendCap,
        remaining_usd: remainingUsd !== null ? remainingUsd.toFixed(2) : null,
        spend_cap_usd: spendCapUsd.toFixed(2),
        amount_spent_usd: amountSpentUsd.toFixed(2),
        balance_due_usd: balanceDueUsd.toFixed(2),
        messages: totalMessages,
        msg_spend: msgSpend.toFixed(2),
        cost_per_msg_cents: costPerMsgCents,
        orders: totalOrders,
        sales_spend: salesSpend.toFixed(2),
        cost_per_order_usd: costPerOrderUsd,
        campaigns: campaignList,
        error: error || null
      };
    } catch (err) {
      return {
        id: cleanId,
        name: acc.name,
        brand: acc.brand,
        spend: "0.00",
        has_spend_cap: false,
        remaining_usd: null,
        spend_cap_usd: "0.00",
        amount_spent_usd: "0.00",
        balance_due_usd: "0.00",
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
  });

  const results = await Promise.all(promises);

  const sum = (key) => results.reduce((acc, cur) => acc + parseFloat(cur[key] || 0), 0);
  const totalSpendSum = sum("spend");
  const totalRemainingSum = results.reduce(
    (acc, cur) => acc + (cur.has_spend_cap && cur.remaining_usd !== null ? parseFloat(cur.remaining_usd) : 0),
    0
  );
  const hasAnyCap = results.some((r) => r.has_spend_cap && r.remaining_usd !== null);
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
      has_remaining_cap: hasAnyCap,
      total_remaining_usd: totalRemainingSum.toFixed(2),
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

function postMetaCampaignStatus(campaignId, status) {
  return new Promise((resolve, reject) => {
    if (!META_ACCESS_TOKEN) return reject(new Error("META_ACCESS_TOKEN সেট করা নেই"));
    const body = new URLSearchParams({
      status: status,
      access_token: META_ACCESS_TOKEN
    }).toString();

    const options = {
      hostname: "graph.facebook.com",
      path: `/${META_API_VERSION}/${encodeURIComponent(campaignId)}`,
      method: "POST",
      agent: fbAgent,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) reject(new Error(parsed.error.message || "Meta API error"));
          else resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.setTimeout(10000, () => req.destroy(new Error("Meta API timeout")));
    req.write(body);
    req.end();
  });
}

app.post("/api/ads/toggle", requireAuth, async (req, res) => {
  try {
    const campaignId = String((req.body && req.body.campaign_id) || "").trim();
    const targetStatus = String((req.body && req.body.status) || "").toUpperCase();

    if (!campaignId || !["ACTIVE", "PAUSED"].includes(targetStatus)) {
      return res.status(400).json({ error: "Invalid campaign_id or status (ACTIVE / PAUSED)" });
    }

    await postMetaCampaignStatus(campaignId, targetStatus);
    adsCache.clear();
    res.json({ ok: true, campaign_id: campaignId, status: targetStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/daily-report", requireAuth, async (req, res) => {
  try {
    const rawDate = String(req.query.date || "");
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    const scope = resolveScope(req.query.page_id || req.query.scope);
    const win = shiftWindow(targetDate, String(req.query.shift || "all"));

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

    const isShift = win.key !== "all";
    const shiftAssignSql = isShift ? " AND a.assigned_at >= ? AND a.assigned_at < ?" : "";
    const shiftReplySql = isShift ? " AND r.reply_time >= ? AND r.reply_time < ?" : "";
    const shiftParams = isShift ? [win.startMs, win.endMs] : [];

    const convRows = db
      .prepare(
        `SELECT a.moderator AS raw_mod,
                COUNT(DISTINCT a.page_id || ':' || a.sender_id) AS total_conversations
         FROM moderator_assignments a
         WHERE a.day = ?
           AND a.moderator IS NOT NULL${shiftAssignSql}${pcA.sql}
         GROUP BY a.moderator`
      )
      .all(targetDate, ...shiftParams, ...pcA.params);

    const replyRows = db
      .prepare(
        `SELECT r.moderator AS raw_mod,
                COUNT(r.id) AS total_messages
         FROM replies r
         WHERE ${DAY_R} = ?
           AND r.moderator IS NOT NULL${shiftReplySql}${pcR.sql}
         GROUP BY r.moderator`
      )
      .all(targetDate, ...shiftParams, ...pcR.params);

    const phoneRows = db
      .prepare(
        `SELECT a.moderator AS raw_mod,
                COUNT(DISTINCT m.phone_number) AS phones
         FROM messages m
         JOIN moderator_assignments a
           ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
         WHERE m.phone_number IS NOT NULL AND m.phone_number != ''
           AND ${DAY_M} = ?${shiftAssignSql}${pcA.sql}
         GROUP BY a.moderator`
      )
      .all(targetDate, targetDate, ...shiftParams, ...pcA.params);

    const mergedByMod = new Map();
    const ensureMod = (rawMod) => {
      const modName = normalizeModeratorName(rawMod);
      if (!modName) return null;
      if (!mergedByMod.has(modName)) {
        mergedByMod.set(modName, {
          name: modName,
          total_conversations: 0,
          total_messages: 0,
          phone_numbers: 0
        });
      }
      return mergedByMod.get(modName);
    };

    for (const c of convRows) {
      const cur = ensureMod(c.raw_mod);
      if (cur) cur.total_conversations += c.total_conversations || 0;
    }

    for (const r of replyRows) {
      const cur = ensureMod(r.raw_mod);
      if (cur) cur.total_messages += r.total_messages || 0;
    }

    for (const p of phoneRows) {
      const cur = ensureMod(p.raw_mod);
      if (cur) cur.phone_numbers += p.phones || 0;
    }

    const board = Array.from(mergedByMod.values());
    board.sort(
      (a, b) =>
        b.total_conversations - a.total_conversations ||
        b.total_messages - a.total_messages ||
        b.phone_numbers - a.phone_numbers ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );

    const moderatorStats = board.map((m) => ({
      name: m.name,
      total_conversations: m.total_conversations,
      total_messages: m.total_messages,
      phone_numbers: m.phone_numbers,
      msgs_per_customer: m.total_conversations
        ? Math.round((m.total_messages / m.total_conversations) * 10) / 10
        : 0,
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
