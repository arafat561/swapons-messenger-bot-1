"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const FormData = require("form-data");
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

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// ছবি ডিস্কে না জমিয়ে সরাসরি RAM-এ রাখার জন্য memoryStorage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // সর্বোচ্চ 10MB
});

const SESSION_MINUTES = Number(process.env.SESSION_MINUTES || 0);
const SESSION_MS = SESSION_MINUTES > 0 ? SESSION_MINUTES * 60 * 1000 : 0;

const PAGE_TOKENS = {
  "102803132669088": process.env.PAGE_TOKEN_SW1 || process.env.SWAPONS_WORLD_PAGE_TOKEN || "",
  "1133872699971391": process.env.PAGE_TOKEN_SW2 || process.env.SWAPONS_WORLD_PAGE_TOKEN || "",
  "250386238168336": process.env.PAGE_TOKEN_SR || process.env.STONE_ROSE_PAGE_TOKEN || ""
};

function getPageToken(pageId) {
  return PAGE_TOKENS[String(pageId)] || "";
}

const PAGE_NAMES = {
  "102803132669088": "Swapons World",
  "1133872699971391": "Swapons World",
  "250386238168336": "Stone Rose BD"
};

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

function dhakaDate(ts) {
  const t = typeof ts === "number" && !Number.isNaN(ts) ? ts : Date.now();
  return new Date(t + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

function dhakaDayFromIso(isoOrDate) {
  if (!isoOrDate) return dhakaDate(Date.now());
  const ms = typeof isoOrDate === "number" ? isoOrDate : Date.parse(String(isoOrDate));
  if (Number.isNaN(ms)) return dhakaDate(Date.now());
  return dhakaDate(ms);
}

function replyDay(r) {
  if (r && r.reply_time !== null && r.reply_time !== undefined && Number(r.reply_time) > 0) {
    return dhakaDate(Number(r.reply_time));
  }
  return dhakaDayFromIso(r && r.created_at);
}

const BUCKETS = ["pending", "average", "good", "poor", "msgsent", "number"];

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

function matchesScope(pageId, ids) {
  if (!ids || !ids.length) return true;
  return ids.includes(String(pageId));
}

const MODERATORS = [
  { name: "mony", fb_link: "https://www.facebook.com/profile.php?id=61594030833722", aliases: ["mony", "61594030833722"] },
  { name: "shuvro", fb_link: "https://www.facebook.com/profile.php?id=61594801244167", aliases: ["shuvro", "শুভ্র", "61594801244167"] },
  { name: "shihab", fb_link: "https://www.facebook.com/share/19iBuYADbj/?mibextid=wwXIfr", aliases: ["shihab", "19iBuYADbj"] },
  { name: "Faria", fb_link: "https://www.facebook.com/faria.rahman.800321", aliases: ["Faria", "faria", "faria.rahman.800321"] },
  { name: "Sanjana", fb_link: "https://www.facebook.com/share/1PHGk91SEz/", aliases: ["Sanjana", "sanjana", "সানজানা", "1PHGk91SEz"] },
  { name: "ashraful", fb_link: "https://www.facebook.com/profile.php?id=61592130331098&sk=about", aliases: ["ashraful", "আশরাফুল", "61592130331098"] },
  { name: "tania", fb_link: "https://www.facebook.com/profile.php?id=61591664456446", aliases: ["tania", "তানিয়া", "61591664456446"] },
  { name: "eram", fb_link: "https://www.facebook.com/share/1CRG2mozpQ/", aliases: ["eram", "ইরাম", "1CRG2mozpQ"] },
  { name: "fahim", fb_link: "https://www.facebook.com/ferdous.fahim.921", aliases: ["fahim", "ফাহিম", "ferdous.fahim.921"] },
  { name: "jaber", fb_link: "https://www.facebook.com/share/19kYfdY2fr/", aliases: ["jaber", "জাবের", "19kYfdY2fr"] },
  { name: "apon", fb_link: "https://www.facebook.com/profile.php?id=61593951013042&mibextid=ZbWKwL", aliases: ["apon", "আপন", "61593951013042"] },
  { name: "rifat", fb_link: "https://www.facebook.com/profile.php?id=61594203401850", aliases: ["rifat", "রিফাত", "Muhammad Rifat Molla", "61594203401850"] },
  { name: "halim", fb_link: "https://www.facebook.com/profile.php?id=61594028540149", aliases: ["halim", "হালিম", "61594028540149"] },
  { name: "farjana", fb_link: "https://www.facebook.com/share/1PoAchCNQh/", aliases: ["farjana", "ফারজানা", "1PoAchCNQh"] },
  { name: "apurbo", fb_link: "https://www.facebook.com/profile.php?id=61592804760356", aliases: ["apurbo", "অপুর্ব", "অপূর্ব", "61592804760356"] },
  { name: "ruman", fb_link: "https://www.facebook.com/ruman.hossen.342329", aliases: ["ruman", "রুমান", "Ruman Hossen", "ruman.hossen.342329"] },
  { name: "saidul", fb_link: "https://www.facebook.com/profile.php?id=61592488485671", aliases: ["saidul", "সাইদুল", "61592488485671"] },
  { name: "samir", fb_link: "https://www.facebook.com/share/r/1DWP6xPJpU/?mibextid=wwXIfr", aliases: ["samir", "সামির", "1DWP6xPJpU"] }
];

function extractFbIdentifier(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s.length > 140) return null;

  const idQuery = s.match(/[?&]id=(\d{5,})/i);
  if (idQuery) return idQuery[1];

  const sharePath = s.match(/facebook\.com\/share\/(?:[a-z]\/)?([A-Za-z0-9_-]+)/i);
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

function registerAlias(alias, modName) {
  if (!alias || !modName) return;
  const rawKey = String(alias).trim();
  if (!rawKey) return;
  FB_LINK_TO_MODERATOR.set(rawKey.toLowerCase(), modName);
  const extracted = extractFbIdentifier(rawKey);
  if (extracted) FB_LINK_TO_MODERATOR.set(extracted.toLowerCase(), modName);
}

for (const mod of MODERATORS) {
  const keys = [mod.name, mod.fb_link, ...(mod.aliases || [])];
  for (const k of keys) registerAlias(k, mod.name);
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

const BN_RANGE = "\\u0980-\\u09FF";
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MODERATOR_WELCOME_RULES = MODERATORS.map((m) => {
  const names = [m.name, ...(m.aliases || [])].filter((t) => t && !/^\d+$/.test(String(t).trim()));
  const alt = names
    .map((a) => String(a).normalize("NFC").trim().split(/\s+/).map(escapeRegex).join("\\s+"))
    .join("|");
  return {
    name: m.name,
    re: alt
      ? new RegExp(`(?<![\\w${BN_RANGE}])(?:আমি|ami|I\\s*am|I'm)\\s+(?:${alt})(?![\\w${BN_RANGE}])`, "i")
      : null
  };
});

function detectModeratorFromWelcomeText(text) {
  if (!text) return null;
  const clean = String(text).normalize("NFC");
  for (const rule of MODERATOR_WELCOME_RULES) {
    if (rule.re && rule.re.test(clean)) {
      return rule.name;
    }
  }
  return null;
}

function normalizeModeratorName(rawMod) {
  if (!rawMod) return null;
  const trimmed = String(rawMod).trim();
  if (!trimmed) return null;
  return detectModeratorByFbLink(trimmed) || detectModeratorFromWelcomeText(trimmed) || trimmed;
}

app.use(express.json({ limit: "25mb" }));

// পুরনো লোকাল uploads ফোল্ডার থাকলে শুধু static হিসেবে রাখা (নতুন কিছু লেখা হবে না)
const legacyUploadDir = path.join(__dirname, "uploads");
if (fs.existsSync(legacyUploadDir)) {
  app.use("/uploads", express.static(legacyUploadDir));
}

/* ------------------------------------------------------------------ */
/* Supabase Helper Tables                                             */
/* ------------------------------------------------------------------ */
async function loadDbAliases() {
  try {
    const { data, error } = await supabase.from("mod_aliases").select("alias, moderator");
    if (!error && Array.isArray(data)) {
      for (const r of data) {
        registerAlias(r.alias, r.moderator);
      }
    }
  } catch (e) {}
}

async function seedDefaultSavedRepliesIfEmpty() {
  try {
    const { count, error } = await supabase
      .from("saved_replies")
      .select("id", { count: "exact", head: true });
    if (!error && (count || 0) === 0) {
      const nowSeed = Date.now();
      await supabase.from("saved_replies").upsert([
        {
          id: "sr_default_1",
          title: "number",
          reply_text: "📞 বিস্তারিত জানতে অনুগ্রহ করে আপনার মোবাইল নাম্বারটি দিন। চ্যাটে অনেক সময় লাগতে পারে, তাই আমাদের প্রতিনিধি আপনাকে ফোন করে বিস্তারিত জানিয়ে দেবে। 😊",
          source: "default",
          created_by: "system",
          updated_at: nowSeed - 4000,
          page_group: "all"
        },
        {
          id: "sr_default_2",
          title: "kon",
          reply_text: "স্যার, আপনি কি এমন কোনো প্রোডাক্ট খুঁজছিলেন? আপনার পছন্দের কালার বা ডিজাইনটি জানালে আমি বিস্তারিত জানাচ্ছি। 😊",
          source: "default",
          created_by: "system",
          updated_at: nowSeed - 3000,
          page_group: "all"
        },
        {
          id: "sr_default_3",
          title: "kon",
          reply_text: "কোন সাইজ লাগবে জানাবেন স্যার / ম্যাম ?",
          source: "default",
          created_by: "system",
          updated_at: nowSeed - 2000,
          page_group: "all"
        },
        {
          id: "sr_default_4",
          title: "mark",
          reply_text: "কোন কালার টি চাচ্ছেন স্যার ছবির উপর মার্ক করে দিন",
          source: "default",
          created_by: "system",
          updated_at: nowSeed - 1000,
          page_group: "all"
        }
      ]);
    }
  } catch (e) {}
}

async function purgeOldEchoLogs() {
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    await supabase.from("echo_log").delete().lt("created_ms", cutoff);
  } catch (e) {}
}

function isBlockedStickerUrl(url) {
  if (!url) return false;
  const u = String(url);
  return u.includes("39178562_1505197616293642") || u.includes("/stickers/");
}

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
    req.setTimeout(10000, () => req.destroy(new Error("Meta API timeout")));
    req.write(payload);
    req.end();
  });
}

// RAM buffer থেকে সরাসরি Meta Graph API-তে ছবি পাঠানোর হেল্পার (ডিস্কে সেভ হয় না)
async function sendFacebookImageBuffer(pageId, recipientId, buffer, filename, mimetype) {
  const token = getPageToken(pageId);
  if (!token) {
    throw new Error(`Page ID (${pageId}) এর জন্য Page Access Token সেট করা নেই!`);
  }

  const form = new FormData();
  form.append("recipient", JSON.stringify({ id: String(recipientId) }));
  form.append(
    "message",
    JSON.stringify({
      attachment: {
        type: "image",
        payload: { is_reusable: true }
      }
    })
  );
  form.append("filedata", buffer, {
    filename: filename || "photo.jpg",
    contentType: mimetype || "image/jpeg"
  });

  const url = `https://graph.facebook.com/${META_API_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    body: form,
    headers: form.getHeaders()
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error((data && data.error && data.error.message) || "Meta image send failed");
  }
  return data;
}

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

function parseAdJson(raw) {
  if (!raw) return null;
  try {
    const tmp = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (tmp && typeof tmp === "object" && !isBlockedStickerUrl(tmp.photo_url) && !isBlockedStickerUrl(tmp.post_url)) {
      return tmp;
    }
  } catch (e) {}
  return null;
}

/* ------------------------------------------------------------------ */
/* Ad enrich: ad_id থেকে Meta Graph দিয়ে ভিডিও / ছবি / পোস্ট লিংক আনা  */
/* ------------------------------------------------------------------ */
async function enrichAdObject(pageId, ad) {
  if (!ad || !ad.ad_id) return ad;
  const token = META_ACCESS_TOKEN || getPageToken(pageId);
  const out = { ...ad, enriched: true, enriched_at: Date.now() };
  delete out.enrich_error;

  if (!token) {
    out.enrich_error = "META_ACCESS_TOKEN সেট করা নেই";
    return out;
  }

  const fields = "name,creative{thumbnail_url,image_url,video_id,effective_object_story_id,object_story_id,instagram_permalink_url}";
  const r = await httpsGetJson(
    `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(ad.ad_id)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`
  );

  if (!r) {
    out.enrich_error = "Meta API-তে সংযোগ হয়নি";
    return out;
  }
  if (r.error) {
    out.enrich_error = r.error.message || "Meta API error";
    return out;
  }

  const cr = r.creative || {};
  if (r.name && (!ad.ad_title || String(ad.ad_title).startsWith("Facebook Ad"))) {
    out.ad_title = r.name;
  }

  const storyId = cr.effective_object_story_id || cr.object_story_id;
  if (storyId) out.post_url = `https://www.facebook.com/${storyId}`;
  else if (!out.post_url && cr.instagram_permalink_url) out.post_url = cr.instagram_permalink_url;

  const img = cr.image_url || cr.thumbnail_url || "";
  if (img && !isBlockedStickerUrl(img) && !out.photo_url) out.photo_url = img;

  if (cr.video_id) {
    out.media_type = "video";
    out.video_id = String(cr.video_id);
    const v = await httpsGetJson(
      `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(cr.video_id)}?fields=source,permalink_url,picture&access_token=${encodeURIComponent(token)}`
    );
    if (v && !v.error) {
      if (v.source) out.video_url = v.source;
      if (v.permalink_url) out.video_page_url = `https://www.facebook.com${v.permalink_url}`;
      if (v.picture && !out.photo_url) out.photo_url = v.picture;
    } else if (v && v.error) {
      out.enrich_error = v.error.message || "Video fetch error";
    }
  } else if (out.media_type !== "video") {
    out.media_type = out.photo_url ? "image" : "link";
  }

  return out;
}

function adNeedsEnrich(ad) {
  if (!ad || !ad.ad_id) return false;
  if (!ad.enriched) return true;
  if (ad.enrich_error && Date.now() - Number(ad.enriched_at || 0) > 10 * 60 * 1000) return true;
  return false;
}

const enrichingKeys = new Set();

async function enrichAndStoreAd(pageId, senderId, baseAd) {
  const key = `${pageId}:${senderId}`;
  if (enrichingKeys.has(key)) return baseAd;
  enrichingKeys.add(key);
  try {
    const enriched = await enrichAdObject(pageId, baseAd);
    await supabase
      .from("customers")
      .upsert(
        { page_id: String(pageId), sender_id: String(senderId), ad_info: enriched },
        { onConflict: "page_id,sender_id" }
      );
    return enriched;
  } catch (e) {
    return baseAd;
  } finally {
    enrichingKeys.delete(key);
  }
}

async function syncCustomerAndAdFromGraph(pageId, senderId) {
  const token = getPageToken(pageId);
  if (!token) return null;

  try {
    const { data: existing } = await supabase
      .from("customers")
      .select("name, profile_pic, ad_info")
      .eq("page_id", String(pageId))
      .eq("sender_id", String(senderId))
      .maybeSingle();

    let fullName = existing && existing.name && !String(existing.name).startsWith("Customer_") ? existing.name : "";
    let picUrl = existing && existing.profile_pic ? existing.profile_pic : "";
    const existingAd = existing ? parseAdJson(existing.ad_info) : null;

    if (!fullName || !picUrl) {
      const profile = await httpsGetJson(
        `https://graph.facebook.com/${META_API_VERSION}/${senderId}?fields=first_name,last_name,name,profile_pic&access_token=${token}`
      );
      if (profile && !profile.error) {
        if (profile.name || profile.first_name) {
          fullName = profile.name || `${profile.first_name || ""} ${profile.last_name || ""}`.trim();
        }
        if (profile.profile_pic) {
          picUrl = profile.profile_pic;
        }
      }
    }

    if (!fullName) {
      const convUrl = `https://graph.facebook.com/${META_API_VERSION}/me/conversations?user_id=${senderId}&fields=participants&access_token=${token}`;
      const conv = await httpsGetJson(convUrl);
      if (conv && conv.data && conv.data[0] && conv.data[0].participants && conv.data[0].participants.data) {
        const custPart = conv.data[0].participants.data.find((p) => String(p.id) === String(senderId));
        if (custPart && custPart.name) fullName = custPart.name;
      }
    }

    if (fullName || picUrl) {
      await supabase
        .from("customers")
        .upsert(
          {
            page_id: String(pageId),
            sender_id: String(senderId),
            name: fullName || (existing && existing.name) || `Customer_${String(senderId).slice(-4)}`,
            profile_pic: picUrl || (existing && existing.profile_pic) || null
          },
          { onConflict: "page_id,sender_id" }
        );
    }

    return existingAd;
  } catch (e) {}
  return null;
}

/* ------------------------------------------------------------------ */
/* Auth & Session (Supabase sessions table)                           */
/* ------------------------------------------------------------------ */
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

async function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  await supabase.from("sessions").insert({ token_hash: hashToken(token), created_at: now });
  return { token, expiresAt: SESSION_MS ? now + SESSION_MS : null };
}

async function sessionValid(token) {
  if (!token) return false;
  const h = hashToken(token);
  const { data: row, error } = await supabase
    .from("sessions")
    .select("created_at")
    .eq("token_hash", h)
    .maybeSingle();
  if (error || !row) return false;
  if (SESSION_MS && Date.now() - Number(row.created_at) >= SESSION_MS) {
    await supabase.from("sessions").delete().eq("token_hash", h);
    return false;
  }
  return true;
}

if (SESSION_MS) {
  setInterval(async () => {
    try {
      await supabase.from("sessions").delete().lt("created_at", Date.now() - SESSION_MS);
    } catch (e) {}
  }, 60 * 1000).unref();
}

const failedLogins = new Map();
const MAX_FAILS = 5;
const BLOCK_MS = 60 * 1000;

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

app.post("/api/login", async (req, res) => {
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
    const s = await createSession();
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

app.post("/api/logout", async (req, res) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme === "Bearer" && token) {
    await supabase.from("sessions").delete().eq("token_hash", hashToken(token));
  }
  res.json({ ok: true });
});

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme === "Bearer" && (await sessionValid(token))) {
    return next();
  }
  return res.status(401).json({ error: "Session ended. Please sign in again." });
}

async function requireModAuth(req, res, next) {
  const modPass = req.headers["x-mod-pass"];
  if (modPass === MOD_PASS || modPass === DASHBOARD_PASS || modPass === "swapon123") {
    return next();
  }
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme === "Bearer" && (await sessionValid(token))) {
    return next();
  }
  return res.status(401).json({ error: "ভুল মডারেটর পাসওয়ার্ড!" });
}

async function requireDebugAuth(req, res, next) {
  const key = String(req.query.key || "");
  if (key && (safeEqual(key, DASHBOARD_PASS) || safeEqual(key, MOD_PASS) || key === "swapon123")) {
    return next();
  }
  return requireModAuth(req, res, next);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/inbox", (req, res) => {
  res.sendFile(path.join(__dirname, "inbox.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
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

/* ------------------------------------------------------------------ */
/* Ad referral (Click-to-Messenger ad থেকে আসা কাস্টমার)               */
/* ------------------------------------------------------------------ */
const referralLog = [];

function extractAdReferral(event) {
  const ref =
    event.referral ||
    (event.message && event.message.referral) ||
    (event.postback && event.postback.referral);
  if (!ref) return null;

  const ctx = ref.ads_context_data || {};
  const adId = String(ref.ad_id || ref.id || "");
  const hasAdSignal = adId || Object.keys(ctx).length > 0 || String(ref.source || "").toUpperCase() === "ADS";

  try {
    referralLog.unshift({ t: Date.now(), sender: event.sender && event.sender.id, ref });
    if (referralLog.length > 40) referralLog.length = 40;
  } catch (e) {}

  if (!hasAdSignal) return null;

  const postId = ctx.post_id ? String(ctx.post_id) : "";
  const photoUrl = ctx.photo_url || "";
  const videoUrl = ctx.video_url || "";
  const postUrl = ctx.post_url || ref.ad_url || (postId ? `https://www.facebook.com/${postId}` : "");

  if (isBlockedStickerUrl(photoUrl) || isBlockedStickerUrl(postUrl)) return null;

  return {
    ad_id: adId,
    ad_title: ctx.ad_title || ref.title || (adId ? `Facebook Ad #${adId}` : "Facebook Ad"),
    media_type: videoUrl ? "video" : photoUrl ? "image" : "link",
    post_url: postUrl,
    photo_url: photoUrl,
    video_url: videoUrl,
    post_id: postId
  };
}

async function resolveEchoModerator(pageId, customerId, event) {
  const info = { mod: null, via: "", fromId: "", fromName: "" };
  const replyText = String((event.message && event.message.text) || "").trim();

  const welcomeName = detectModeratorFromWelcomeText(replyText);
  if (welcomeName) {
    info.mod = welcomeName;
    info.via = "welcome_text";
    return info;
  }

  const tryFrom = (from, via) => {
    if (!from || !from.id || String(from.id) === String(pageId)) return false;
    if (!info.fromId) {
      info.fromId = String(from.id);
      info.fromName = String(from.name || "");
    }
    const byId = detectModeratorByFbLink(from.id);
    if (byId) { info.mod = byId; info.via = via + ":id"; return true; }
    if (from.name) {
      const byName = detectModeratorByFbLink(from.name) || detectModeratorFromWelcomeText(from.name);
      if (byName) { info.mod = byName; info.via = via + ":name"; return true; }
    }
    return false;
  };

  if (event.message && tryFrom(event.message.from, "echo_from")) return info;

  const token = getPageToken(pageId);
  const mid = event.message && event.message.mid;

  if (token && mid) {
    try {
      const msgUrl = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(mid)}?fields=from&access_token=${encodeURIComponent(token)}`;
      const msgInfo = await httpsGetJson(msgUrl);
      if (msgInfo && tryFrom(msgInfo.from, "graph_msg")) return info;
    } catch (e) {}
  }

  if (token && customerId) {
    try {
      const convUrl = `https://graph.facebook.com/${META_API_VERSION}/me/conversations?user_id=${encodeURIComponent(customerId)}&fields=messages.limit(6){id,message,from}&access_token=${encodeURIComponent(token)}`;
      const conv = await httpsGetJson(convUrl);
      const msgs = conv && conv.data && conv.data[0] && conv.data[0].messages && conv.data[0].messages.data;
      if (Array.isArray(msgs)) {
        const exactMid = mid && msgs.find((m) => String(m.id) === String(mid));
        const byText = !exactMid && replyText && msgs.find((m) => String(m.message || "").trim() === replyText && m.from && String(m.from.id) !== String(pageId));
        const matchedMsg = exactMid || byText;
        if (matchedMsg && tryFrom(matchedMsg.from, "conv")) return info;
      }
    } catch (e) {}
  }

  try {
    const dayStr = dhakaDate(event.timestamp || Date.now());
    const { data: row } = await supabase
      .from("moderator_assignments")
      .select("moderator")
      .eq("page_id", String(pageId))
      .eq("sender_id", String(customerId))
      .eq("day", dayStr)
      .maybeSingle();
    if (row && row.moderator) {
      info.mod = row.moderator;
      info.via = "assignment_fallback";
    }
  } catch (e) {}

  return info;
}

async function assignModeratorIfUnassigned(pageId, senderId, day, moderator, assignedAt) {
  const { data: existing } = await supabase
    .from("moderator_assignments")
    .select("moderator")
    .eq("page_id", String(pageId))
    .eq("sender_id", String(senderId))
    .eq("day", day)
    .maybeSingle();

  if (!existing) {
    await supabase.from("moderator_assignments").insert({
      page_id: String(pageId),
      sender_id: String(senderId),
      day,
      moderator,
      assigned_at: assignedAt,
      bucket: "pending"
    });
  }
}

async function markCustomerMessagesReplied(pageId, senderId, day) {
  const { data: rows } = await supabase
    .from("messages")
    .select("id, created_at, status")
    .eq("page_id", String(pageId))
    .eq("sender_id", String(senderId))
    .neq("status", "replied");

  const ids = (rows || [])
    .filter((r) => dhakaDayFromIso(r.created_at) === day)
    .map((r) => r.id);

  if (ids.length) {
    await supabase.from("messages").update({ status: "replied" }).in("id", ids);
  }
}

async function handleMessagingEvent(pageId, event) {
  const pId = String(pageId);
  const senderId = event.sender && event.sender.id ? String(event.sender.id) : "";
  const adObj = extractAdReferral(event);

  if (adObj && senderId && (!event.message || !event.message.is_echo)) {
    await supabase
      .from("customers")
      .upsert({ page_id: pId, sender_id: senderId, ad_info: adObj }, { onConflict: "page_id,sender_id" });

    if (adObj.ad_id) {
      enrichAndStoreAd(pId, senderId, adObj).catch(() => {});
    }
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
    const msgTime = Number(event.timestamp || Date.now());

    await supabase.from("messages").upsert(
      {
        page_id: pId,
        sender_id: senderId,
        message_id: event.message.mid,
        message_text: displayText,
        image_url: imageUrl,
        ad_info: adObj,
        message_time: msgTime,
        phone_number: extractPhoneNumber(rawText),
        status: "unread"
      },
      { onConflict: "message_id", ignoreDuplicates: true }
    );

    syncCustomerAndAdFromGraph(pId, senderId).catch(() => {});
    return;
  }

  if (event.postback || event.referral) {
    const ts = Number(event.timestamp || Date.now());
    const mid = (event.postback && event.postback.mid) || `ref_${senderId}_${ts}`;
    const text = (event.postback && (event.postback.title || event.postback.payload)) || "📢 Ad থেকে ইনবক্সে এসেছেন";

    await supabase.from("messages").upsert(
      {
        page_id: pId,
        sender_id: senderId,
        message_id: mid,
        message_text: text,
        image_url: null,
        ad_info: adObj,
        message_time: ts,
        phone_number: extractPhoneNumber(text),
        status: "unread"
      },
      { onConflict: "message_id", ignoreDuplicates: true }
    );

    syncCustomerAndAdFromGraph(pId, senderId).catch(() => {});
    return;
  }

  if (event.message && event.message.is_echo) {
    const customerId = event.recipient && event.recipient.id ? String(event.recipient.id) : "";
    if (!customerId) return;

    const replyText = event.message.text || "";
    let replyImg = null;
    if (event.message.attachments && event.message.attachments.length > 0) {
      const att = event.message.attachments[0];
      if (att.payload && att.payload.url && !isBlockedStickerUrl(att.payload.url)) {
        replyImg = att.payload.url;
      }
    }

    const replyTime = Number(event.timestamp || Date.now());
    const replyDay = dhakaDate(replyTime);

    const { data: recentModReplies } = await supabase
      .from("replies")
      .select("id, reply_text, image_url, reply_time")
      .eq("page_id", pId)
      .eq("sender_id", customerId)
      .like("message_id", "mod_%");

    const sentFromDashboard = (recentModReplies || []).some((r) => {
      const diff = Math.abs(Number(r.reply_time || 0) - replyTime);
      if (diff > 30000) return false;
      if (replyText) return String(r.reply_text || "") === replyText;
      if (replyImg) return Boolean(r.image_url);
      return false;
    });
    if (sentFromDashboard) return;

    const isConfirm = replyText.toLowerCase().includes("your order confirm") ? 1 : 0;
    const resolved = await resolveEchoModerator(pId, customerId, event);
    const mod = resolved.mod;

    const { data: exists } = await supabase
      .from("replies")
      .select("id")
      .eq("message_id", event.message.mid)
      .maybeSingle();

    if (!exists) {
      await supabase.from("replies").insert({
        page_id: pId,
        sender_id: customerId,
        message_id: event.message.mid,
        reply_text: replyText || (replyImg ? "[ছবি]" : "👍"),
        image_url: replyImg,
        reply_time: replyTime,
        moderator: mod,
        is_order_confirm: isConfirm
      });

      try {
        await supabase.from("echo_log").insert({
          page_id: pId,
          customer_id: customerId,
          mid: event.message.mid || "",
          text: String(replyText).slice(0, 80),
          from_id: resolved.fromId,
          from_name: resolved.fromName,
          app_id: String(event.message.app_id || ""),
          via: resolved.via || "unresolved",
          moderator: mod || "",
          created_ms: Date.now()
        });
      } catch (e) {}
    }

    if (mod) await assignModeratorIfUnassigned(pId, customerId, replyDay, mod, replyTime);
    await markCustomerMessagesReplied(pId, customerId, replyDay);
    return;
  }

  if (event.read && senderId) {
    const watermark = Number(event.read.watermark || Date.now());
    const { data: unreadRows } = await supabase
      .from("messages")
      .select("id, message_time")
      .eq("page_id", pId)
      .eq("sender_id", senderId)
      .eq("status", "unread");

    const ids = (unreadRows || [])
      .filter((r) => Number(r.message_time || 0) <= watermark)
      .map((r) => r.id);

    if (ids.length) {
      await supabase.from("messages").update({ status: "read", read_time: Date.now() }).in("id", ids);
    }
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

/* ------------------------------------------------------------------ */
/* Debug: Meta আসলে কী referral পাঠাচ্ছে                               */
/* ------------------------------------------------------------------ */
app.get("/api/referral-log", requireDebugAuth, async (req, res) => {
  try {
    const { data: dbRows } = await supabase
      .from("messages")
      .select("page_id, sender_id, message_text, ad_info, message_time")
      .not("ad_info", "is", null)
      .order("id", { ascending: false })
      .limit(50);

    const parsed = (dbRows || []).map((r) => {
      const ad = parseAdJson(r.ad_info);
      return {
        page_id: r.page_id,
        sender_id: r.sender_id,
        message_text: r.message_text,
        ad_id: ad && ad.ad_id ? ad.ad_id : "",
        ad_title: ad && ad.ad_title ? ad.ad_title : "",
        time: r.message_time
      };
    });

    res.json({
      count: parsed.length,
      logs: parsed,
      live_memory_count: referralLog.length,
      live_memory_rows: referralLog
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Moderator ID debug / mapping                                        */
/* ------------------------------------------------------------------ */
app.get("/api/echo-log", requireDebugAuth, async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from("echo_log")
      .select("page_id, customer_id, text, from_id, from_name, app_id, via, moderator, created_ms")
      .order("id", { ascending: false })
      .limit(150);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: (rows || []).length, rows: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/mod-alias", requireDebugAuth, async (req, res) => {
  try {
    const alias = String(req.query.alias || "").trim();
    const modName = normalizeModeratorName(String(req.query.moderator || ""));
    const known = MODERATORS.find((m) => m.name === modName);
    if (!alias || !known) {
      return res.status(400).json({ error: "alias আর সঠিক moderator নাম দিন", moderators: MODERATORS.map((m) => m.name) });
    }

    await supabase.from("mod_aliases").upsert({ alias, moderator: known.name }, { onConflict: "alias" });
    registerAlias(alias, known.name);

    const { data: echoRows } = await supabase.from("echo_log").select("mid").eq("from_id", alias);
    const mids = (echoRows || []).map((x) => x.mid).filter(Boolean);
    let fixedCount = 0;
    if (mids.length) {
      const { data: updated } = await supabase
        .from("replies")
        .update({ moderator: known.name })
        .in("message_id", mids)
        .select("id");
      fixedCount = (updated || []).length;
    }

    res.json({ ok: true, alias, moderator: known.name, old_replies_fixed: fixedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Shared Saved Replies (Page-wise + Meta Sync)                        */
/* ------------------------------------------------------------------ */
function groupOf(raw) {
  const v = String(raw || "").trim();
  if (!v || v === "all") return "";
  return PAGE_TO_GROUP[v] || (PAGE_GROUPS[v] ? v : "");
}

function mapSavedRow(r) {
  return {
    id: r.id,
    title: r.title,
    text: r.reply_text,
    source: r.source,
    created_by: r.created_by,
    updated_at: r.updated_at,
    page_group: r.page_group || "all"
  };
}

async function listSavedRepliesFor(rawPage) {
  const g = groupOf(rawPage);
  let query = supabase
    .from("saved_replies")
    .select("id, title, reply_text, source, created_by, updated_at, page_group")
    .order("updated_at", { ascending: false });

  if (g) {
    query = query.in("page_group", ["all", g]);
  }

  const { data: rows, error } = await query;
  if (error) throw error;
  return (rows || []).map(mapSavedRow);
}

app.get("/api/saved-replies", requireModAuth, async (req, res) => {
  try {
    res.json({ replies: await listSavedRepliesFor(req.query.page_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/saved-replies", requireModAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const id = String(body.id || `sr_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`).trim();
    const title = String(body.title || "quick").trim() || "quick";
    const text = String(body.text || "").trim();
    const createdBy = String(body.created_by || "moderator").trim();
    const group = groupOf(body.page_id || body.page_group) || "all";
    const now = Date.now();

    if (!text && !title) {
      return res.status(400).json({ error: "Title or reply text required" });
    }

    await supabase.from("saved_replies").upsert(
      {
        id,
        title,
        reply_text: text,
        source: "shared",
        created_by: createdBy,
        updated_at: now,
        page_group: group
      },
      { onConflict: "id" }
    );

    res.json({
      ok: true,
      reply: { id, title, text, source: "shared", created_by: createdBy, updated_at: now, page_group: group }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/saved-replies/:id", requireModAuth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Invalid ID" });
    await supabase.from("saved_replies").delete().eq("id", id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function fetchPagedList(firstUrl) {
  let rows = [];
  let next = firstUrl;
  let guard = 0;
  while (next && guard < 10) {
    const r = await httpsGetJson(next);
    if (!r) return { rows, error: "Meta API-তে সংযোগ হয়নি" };
    if (r.error) return { rows, error: r.error.message || "Meta API error" };
    if (Array.isArray(r.data)) rows = rows.concat(r.data);
    next = r.paging && r.paging.next ? r.paging.next : null;
    guard += 1;
  }
  return { rows, error: null };
}

async function syncMetaSavedRepliesNow() {
  let imported = 0;
  const errors = [];

  const tokenEntries = Object.entries(PAGE_TOKENS).filter(([, t]) => Boolean(t));
  if (!tokenEntries.length && META_ACCESS_TOKEN) {
    const pagesRes = await httpsGetJson(
      `https://graph.facebook.com/${META_API_VERSION}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`
    );
    if (pagesRes && Array.isArray(pagesRes.data)) {
      for (const p of pagesRes.data) {
        if (p && p.id && p.access_token) tokenEntries.push([String(p.id), String(p.access_token)]);
      }
    }
  }

  const fetchedByGroup = new Map();
  const failedGroups = new Set();

  for (const [pageId, token] of tokenEntries) {
    const group = PAGE_TO_GROUP[pageId] || "all";
    const edges = ["saved_message_responses", "saved_replies"];
    let result = null;
    let lastErr = null;

    for (const edge of edges) {
      const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(pageId)}/${edge}?fields=id,title,message&limit=100&access_token=${encodeURIComponent(token)}`;
      const r = await fetchPagedList(url);
      if (!r.error) { result = r; break; }
      lastErr = r.error;
    }

    if (!result) {
      failedGroups.add(group);
      errors.push(`${PAGE_NAMES[pageId] || pageId}: ${lastErr}`);
      continue;
    }

    if (!fetchedByGroup.has(group)) fetchedByGroup.set(group, new Set());
    const now = Date.now();

    for (const item of result.rows) {
      const msgTxt = String(item.message || "").trim();
      if (!msgTxt) continue;
      const title = String(item.title || "").trim() || msgTxt.slice(0, 20);
      const hash = crypto.createHash("sha1").update(`${title}|${msgTxt}`).digest("hex").slice(0, 12);
      const srId = `meta_${group}_${hash}`;
      await supabase.from("saved_replies").upsert(
        {
          id: srId,
          title,
          reply_text: msgTxt,
          source: "meta",
          created_by: PAGE_NAMES[pageId] || pageId,
          updated_at: now,
          page_group: group
        },
        { onConflict: "id" }
      );
      fetchedByGroup.get(group).add(srId);
      imported += 1;
    }
  }

  for (const [group, idSet] of fetchedByGroup.entries()) {
    if (failedGroups.has(group)) continue;
    const { data: existing } = await supabase
      .from("saved_replies")
      .select("id")
      .eq("source", "meta")
      .eq("page_group", group);

    const toDelete = (existing || []).map((r) => r.id).filter((id) => !idSet.has(id));
    if (toDelete.length) {
      await supabase.from("saved_replies").delete().in("id", toDelete);
    }
  }

  return { imported, errors };
}

app.post("/api/saved-replies/sync-meta", requireModAuth, async (req, res) => {
  try {
    const { imported, errors } = await syncMetaSavedRepliesNow();
    const pageRef = (req.body && req.body.page_id) || req.query.page_id;
    res.json({ ok: true, imported, errors, replies: await listSavedRepliesFor(pageRef) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

setTimeout(() => { syncMetaSavedRepliesNow().catch(() => {}); }, 8000);
setInterval(() => { syncMetaSavedRepliesNow().catch(() => {}); }, 10 * 60 * 1000).unref();

app.get("/api/mod/list", (req, res) => {
  res.json({ moderators: MODERATORS.map((m) => m.name) });
});

async function sentMessagesByModerator(day, ids) {
  const { data: rows, error } = await supabase
    .from("replies")
    .select("page_id, sender_id, moderator, reply_time, created_at")
    .not("moderator", "is", null)
    .neq("moderator", "");

  if (error) throw error;

  const map = new Map();
  const custSetByMod = new Map();

  for (const r of rows || []) {
    if (!matchesScope(r.page_id, ids)) continue;
    if (replyDay(r) !== day) continue;
    const name = normalizeModeratorName(r.moderator);
    if (!name) continue;

    const cur = map.get(name) || { msgs: 0, custs: 0 };
    cur.msgs += 1;
    map.set(name, cur);

    if (!custSetByMod.has(name)) custSetByMod.set(name, new Set());
    custSetByMod.get(name).add(`${r.page_id}:${r.sender_id}`);
  }

  for (const [name, set] of custSetByMod.entries()) {
    const cur = map.get(name);
    if (cur) cur.custs = set.size;
  }

  return map;
}

app.post("/api/mod/batch", requireModAuth, async (req, res) => {
  try {
    const { moderator, requestNew, pageFilter, bucket, date } = req.body;
    if (!moderator) return res.status(400).json({ error: "Moderator name required" });

    const todayStr = dhakaDate();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : todayStr;
    const isToday = day === todayStr;

    const activeBucket = BUCKETS.includes(bucket) ? bucket : "pending";
    const scope = resolveScope(pageFilter || "all");

    const [{ data: allMsgs }, { data: allCusts }, { data: allAssigns }, { data: allReads }] = await Promise.all([
      supabase.from("messages").select("id, page_id, sender_id, message_text, ad_info, message_time, status, created_at"),
      supabase.from("customers").select("page_id, sender_id, name, profile_pic, ad_info"),
      supabase.from("moderator_assignments").select("page_id, sender_id, day, moderator, bucket").eq("day", day),
      supabase.from("mod_reads").select("page_id, sender_id, read_at")
    ]);

    const custMap = new Map();
    for (const c of allCusts || []) {
      custMap.set(`${c.page_id}:${c.sender_id}`, c);
    }

    const readMap = new Map();
    for (const rd of allReads || []) {
      readMap.set(`${rd.page_id}:${rd.sender_id}`, Number(rd.read_at || 0));
    }

    const dayMsgsAll = (allMsgs || []).filter((m) => dhakaDayFromIso(m.created_at) === day);
    const dayMsgsScoped = dayMsgsAll.filter((m) => matchesScope(m.page_id, scope.ids));

    const assignMap = new Map();
    for (const a of allAssigns || []) {
      assignMap.set(`${a.page_id}:${a.sender_id}`, a);
    }

    const scopedCustKeysWithDayMsg = new Set(dayMsgsScoped.map((m) => `${m.page_id}:${m.sender_id}`));

    if (isToday && (activeBucket === "pending" || requestNew)) {
      let totalPending = 0;
      for (const key of scopedCustKeysWithDayMsg) {
        const a = assignMap.get(key);
        const b = (a && a.bucket) || "pending";
        if (a && a.moderator === moderator && b === "pending") {
          totalPending += 1;
        }
      }

      const slotsNeeded = 10 - totalPending;
      if (slotsNeeded > 0) {
        const seenUnassigned = new Set();
        const unassignedList = [];

        const sortedDayMsgs = [...dayMsgsScoped].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
        for (const m of sortedDayMsgs) {
          const key = `${m.page_id}:${m.sender_id}`;
          if (seenUnassigned.has(key)) continue;
          seenUnassigned.add(key);

          const a = assignMap.get(key);
          if (!a && m.status !== "replied") {
            unassignedList.push({ page_id: String(m.page_id), sender_id: String(m.sender_id) });
            if (unassignedList.length >= slotsNeeded) break;
          }
        }

        if (unassignedList.length) {
          const now = Date.now();
          const inserts = unassignedList.map((item) => ({
            page_id: item.page_id,
            sender_id: item.sender_id,
            day: todayStr,
            moderator,
            assigned_at: now,
            bucket: "pending"
          }));
          await supabase.from("moderator_assignments").insert(inserts);
          for (const ins of inserts) {
            assignMap.set(`${ins.page_id}:${ins.sender_id}`, ins);
          }
        }
      }
    }

    const msgsByCust = new Map();
    for (const m of dayMsgsScoped) {
      const key = `${m.page_id}:${m.sender_id}`;
      if (!msgsByCust.has(key)) msgsByCust.set(key, []);
      msgsByCust.get(key).push(m);
    }

    const counts = {};
    const unread = {};
    BUCKETS.forEach((b) => {
      counts[b] = 0;
      unread[b] = { customers: 0, messages: 0 };
    });

    const queueItems = [];

    for (const [key, list] of msgsByCust.entries()) {
      const a = assignMap.get(key);
      if (!a || a.moderator !== moderator) continue;
      const b = BUCKETS.includes(a.bucket) ? a.bucket : "pending";

      list.sort((x, y) => Number(x.message_time || 0) - Number(y.message_time || 0) || Number(x.id || 0) - Number(y.id || 0));
      const firstMsg = list[0];
      const lastMsg = list[list.length - 1];
      const readAt = readMap.get(key) || 0;
      const uCount = list.filter((x) => Number(x.message_time || 0) > readAt).length;

      counts[b] += 1;
      if (isToday) {
        if (uCount > 0) unread[b].customers += 1;
        unread[b].messages += uCount;
      }

      if (b === activeBucket) {
        const cust = custMap.get(key);
        const adRaw = (cust && cust.ad_info) || firstMsg.ad_info || lastMsg.ad_info || null;
        const pageIdStr = String(firstMsg.page_id);
        const senderIdStr = String(firstMsg.sender_id);

        queueItems.push({
          page_id: pageIdStr,
          sender_id: senderIdStr,
          customer_name: (cust && cust.name) || `Customer_${senderIdStr.slice(-4)}`,
          profile_pic: (cust && cust.profile_pic) || "",
          ad_info: adRaw,
          ad_data: parseAdJson(adRaw),
          last_message: lastMsg.message_text || "",
          last_time: Number(lastMsg.message_time || 0),
          msg_count: list.length,
          unread_count: isToday ? uCount : 0,
          page_name: PAGE_NAMES[pageIdStr] || "Page",
          _first_id: Number(firstMsg.id || 0)
        });
      }
    }

    if (activeBucket === "pending") {
      queueItems.sort((a, b) => a._first_id - b._first_id);
    } else {
      queueItems.sort(
        (a, b) =>
          (b.unread_count > 0 ? 1 : 0) - (a.unread_count > 0 ? 1 : 0) ||
          (b.last_time || 0) - (a.last_time || 0)
      );
    }

    const missingProfiles = queueItems.filter(
      (q) => !q.profile_pic || String(q.customer_name || "").startsWith("Customer_")
    );
    if (missingProfiles.length > 0) {
      Promise.all(
        missingProfiles.slice(0, 5).map((q) => syncCustomerAndAdFromGraph(q.page_id, q.sender_id))
      ).catch(() => {});
    }

    const assignedTotal = BUCKETS.reduce((s, b) => s + counts[b], 0);
    const sentMap = await sentMessagesByModerator(day, scope.ids);
    const myName = normalizeModeratorName(moderator) || moderator;
    const sentMessages = (sentMap.get(myName) || { msgs: 0 }).msgs;

    let globalUnassigned = 0;
    const seenGlobal = new Set();
    for (const m of dayMsgsScoped) {
      const key = `${m.page_id}:${m.sender_id}`;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
      if (!assignMap.has(key) && m.status !== "replied") {
        globalUnassigned += 1;
      }
    }

    res.json({
      moderator,
      day,
      is_today: isToday,
      bucket: activeBucket,
      counts,
      unread,
      assigned_total: assignedTotal,
      sent_messages: sentMessages,
      queue: queueItems.map(({ _first_id, ...rest }) => rest),
      global_unassigned: globalUnassigned
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mod/classify", requireModAuth, async (req, res) => {
  try {
    const { page_id, sender_id, moderator, bucket } = req.body;
    if (!page_id || !sender_id || !moderator || !BUCKETS.includes(bucket)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const today = dhakaDate();
    const now = Date.now();

    await supabase.from("moderator_assignments").upsert(
      {
        page_id: String(page_id),
        sender_id: String(sender_id),
        day: today,
        moderator,
        assigned_at: now,
        bucket
      },
      { onConflict: "page_id,sender_id,day" }
    );

    res.json({ success: true, bucket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/mod/chat", requireModAuth, async (req, res) => {
  try {
    const page_id = String(req.query.page_id || "");
    const sender_id = String(req.query.sender_id || "");

    const [{ data: msgRows }, { data: replyRows }, { data: custRow }] = await Promise.all([
      supabase
        .from("messages")
        .select("message_text, image_url, ad_info, message_time")
        .eq("page_id", page_id)
        .eq("sender_id", sender_id),
      supabase
        .from("replies")
        .select("reply_text, image_url, reply_time, moderator")
        .eq("page_id", page_id)
        .eq("sender_id", sender_id),
      supabase
        .from("customers")
        .select("name, profile_pic, ad_info")
        .eq("page_id", page_id)
        .eq("sender_id", sender_id)
        .maybeSingle()
    ]);

    const incoming = (msgRows || []).map((m) => ({
      sender: "customer",
      text: m.message_text || "👍",
      image_url: m.image_url,
      ad_info: m.ad_info,
      time: Number(m.message_time || 0)
    }));

    const outgoing = (replyRows || []).map((r) => ({
      sender: "page",
      text: r.reply_text || "👍",
      image_url: r.image_url,
      time: Number(r.reply_time || 0),
      moderator: r.moderator
    }));

    let adData = parseAdJson(custRow && custRow.ad_info);
    if (!adData) {
      const withAd = incoming.filter((i) => i.ad_info).map((i) => parseAdJson(i.ad_info)).filter(Boolean);
      if (withAd.length) adData = withAd[withAd.length - 1];
    }

    if (adData && adNeedsEnrich(adData)) {
      try {
        adData = await enrichAndStoreAd(page_id, sender_id, adData);
      } catch (e) {}
    }

    if (!custRow || !custRow.profile_pic) {
      syncCustomerAndAdFromGraph(page_id, sender_id).catch(() => {});
    }

    try {
      const maxIncoming = incoming.reduce((mx, i) => Math.max(mx, Number(i.time) || 0), 0);
      await supabase.from("mod_reads").upsert(
        { page_id, sender_id, read_at: Math.max(Date.now(), maxIncoming) },
        { onConflict: "page_id,sender_id" }
      );
    } catch (e) {}

    const merged = [...incoming, ...outgoing]
      .map((m) => ({
        sender: m.sender,
        text: m.text,
        image_url: m.image_url,
        time: m.time,
        moderator: m.moderator
      }))
      .sort((a, b) => (a.time || 0) - (b.time || 0));

    res.json({
      messages: merged,
      ad_data: adData,
      customer: {
        name: (custRow && custRow.name) || `Customer_${sender_id.slice(-4)}`,
        profile_pic: (custRow && custRow.profile_pic) || ""
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/mod/stats", requireModAuth, async (req, res) => {
  try {
    const rawDate = String(req.query.date || "");
    const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    const scope = resolveScope(req.query.page_id || req.query.scope || "all");

    const [{ data: assignRows }, { data: dayMsgs }] = await Promise.all([
      supabase.from("moderator_assignments").select("page_id, sender_id, moderator, bucket").eq("day", day),
      supabase.from("messages").select("page_id, sender_id, created_at")
    ]);

    const validCustSet = new Set();
    for (const m of dayMsgs || []) {
      if (matchesScope(m.page_id, scope.ids) && dhakaDayFromIso(m.created_at) === day) {
        validCustSet.add(`${m.page_id}:${m.sender_id}`);
      }
    }

    const map = new Map();
    const getRow = (raw) => {
      const name = normalizeModeratorName(raw);
      if (!name) return null;
      if (!map.has(name)) {
        map.set(name, {
          name,
          assigned: 0,
          pending: 0,
          average: 0,
          good: 0,
          poor: 0,
          msgsent: 0,
          number: 0,
          messages_sent: 0,
          customers_replied: 0
        });
      }
      return map.get(name);
    };

    for (const a of assignRows || []) {
      if (!matchesScope(a.page_id, scope.ids)) continue;
      if (!validCustSet.has(`${a.page_id}:${a.sender_id}`)) continue;
      const row = getRow(a.moderator);
      if (!row) continue;
      const b = a.bucket || "pending";
      row.assigned += 1;
      if (row[b] !== undefined) row[b] += 1;
    }

    const sentMap = await sentMessagesByModerator(day, scope.ids);
    for (const [name, v] of sentMap.entries()) {
      const row = getRow(name);
      if (!row) continue;
      row.messages_sent += v.msgs;
      row.customers_replied += v.custs;
    }

    const rows = Array.from(map.values())
      .filter((r) => r.assigned > 0 || r.messages_sent > 0)
      .sort((a, b) => b.messages_sent - a.messages_sent || b.assigned - a.assigned);

    const total = rows.reduce(
      (t, r) => {
        t.assigned += r.assigned;
        t.pending += r.pending;
        t.average += r.average;
        t.good += r.good;
        t.poor += r.poor;
        t.msgsent += r.msgsent;
        t.number += r.number;
        t.messages_sent += r.messages_sent;
        return t;
      },
      { assigned: 0, pending: 0, average: 0, good: 0, poor: 0, msgsent: 0, number: 0, messages_sent: 0 }
    );

    res.json({ date: day, scope: scope.label, rows, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// কাস্টমারকে ছবি বা টেক্সট পাঠানোর রাউট (ছবি ডিস্কে না লিখে RAM buffer থেকে সরাসরি Meta-তে পাঠানো হয়)
app.post("/api/mod/send", requireModAuth, upload.single("image"), async (req, res) => {
  try {
    const body = req.body || {};
    const page_id = String(body.page_id || "").trim();
    const sender_id = String(body.sender_id || "").trim();
    const moderator = String(body.moderator || "").trim();
    const text = body.text || "";
    const imageBase64 = body.imageBase64 || "";

    if (!page_id || !sender_id || !moderator || (!text && !imageBase64 && !req.file)) {
      return res.status(400).json({ error: "মেসেজ অথবা ছবি দিন" });
    }

    const now = Date.now();
    const today = dhakaDate();
    const mid = `mod_${now}_${crypto.randomBytes(3).toString("hex")}`;

    let imgBuffer = null;
    let imgMime = "image/jpeg";
    let imgName = "photo.jpg";
    let savedImageUrl = null;

    if (req.file && req.file.buffer) {
      imgBuffer = req.file.buffer;
      imgMime = req.file.mimetype || "image/jpeg";
      imgName = req.file.originalname || "photo.jpg";
    } else if (imageBase64) {
      const match = String(imageBase64).match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: "Invalid image format" });
      imgMime = match[1];
      const ext = imgMime.split("/")[1].replace("jpeg", "jpg");
      imgName = `img_${now}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
      imgBuffer = Buffer.from(match[2], "base64");
    }

    if (imgBuffer) {
      const fbImgRes = await sendFacebookImageBuffer(page_id, sender_id, imgBuffer, imgName, imgMime);
      savedImageUrl = fbImgRes.attachment_id ? `meta_attachment:${fbImgRes.attachment_id}` : "[ছবি]";
      imgBuffer = null;
      if (req.file) req.file.buffer = null;
    }

    const cleanText = String(text || "").trim();
    const normMod = normalizeModeratorName(moderator) || moderator;
    const isConfirm = cleanText.toLowerCase().includes("your order confirm") ? 1 : 0;

    if (cleanText) {
      await sendFacebookPayload(page_id, {
        recipient: { id: sender_id },
        message: { text: cleanText },
        messaging_type: "RESPONSE"
      });
    }

    await supabase.from("replies").insert({
      page_id,
      sender_id,
      message_id: mid,
      reply_text: cleanText || "[ছবি পাঠানো হয়েছে]",
      image_url: savedImageUrl,
      reply_time: now,
      moderator: normMod,
      is_order_confirm: isConfirm
    });

    await assignModeratorIfUnassigned(page_id, sender_id, today, normMod, now);
    await markCustomerMessagesReplied(page_id, sender_id, today);

    res.json({ success: true, message_id: mid, image_url: savedImageUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Meta Ads                                                            */
/* ------------------------------------------------------------------ */
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
    detailCache.clear();
    res.json({ ok: true, campaign_id: campaignId, status: targetStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const detailCache = new Map();

function buildMetricRow(row, objective) {
  const spend = parseFloat((row && row.spend) || 0);
  const acts = (row && row.actions) || [];
  const m = acts.find((a) => a.action_type === "onsite_conversion.messaging_conversation_started_7d");
  const o = acts.find((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
  const msgs = m ? parseInt(m.value || 0, 10) : 0;
  const orders = o ? parseInt(o.value || 0, 10) : 0;
  const obj = String(objective || "").toUpperCase();
  const isMsgObj = obj.includes("MESSAGES") || obj.includes("ENGAGEMENT");
  const isSalesObj = obj.includes("OUTCOME_SALES") || obj.includes("CONVERSIONS");

  let msgSpend = 0;
  let salesSpend = 0;
  if (msgs > 0 && orders === 0) msgSpend = spend;
  else if (orders > 0 && msgs === 0) salesSpend = spend;
  else if (isMsgObj && !isSalesObj) msgSpend = spend;
  else if (isSalesObj && !isMsgObj) salesSpend = spend;
  else {
    if (msgs > 0) msgSpend = spend / 2;
    if (orders > 0) salesSpend = spend / 2;
  }

  return {
    spend: spend.toFixed(2),
    messages: msgs,
    msg_spend: msgSpend.toFixed(2),
    cost_per_msg_cents: msgs > 0 && msgSpend > 0 ? ((msgSpend / msgs) * 100).toFixed(1) : "0.0",
    orders,
    sales_spend: salesSpend.toFixed(2),
    cost_per_order_usd: orders > 0 && salesSpend > 0 ? (salesSpend / orders).toFixed(2) : "0.00"
  };
}

app.get("/api/ads/campaign-detail", requireAuth, async (req, res) => {
  try {
    if (!META_ACCESS_TOKEN) return res.status(400).json({ error: "META_ACCESS_TOKEN সেট করা নেই" });
    const campaignId = String(req.query.campaign_id || "").trim();
    const objective = String(req.query.objective || "");
    const rawDate = String(req.query.date || "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    if (!/^\d+$/.test(campaignId)) return res.status(400).json({ error: "Invalid campaign_id" });

    const key = `${campaignId}|${date}|${objective}`;
    const hit = detailCache.get(key);
    if (hit && Date.now() - hit.t < 30000) return res.json(hit.v);

    const base = `https://graph.facebook.com/${META_API_VERSION}/${campaignId}`;
    const insightUrl = (level, fields) =>
      `${base}/insights?${new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        level,
        fields,
        time_range: JSON.stringify({ since: date, until: date }),
        use_unified_attribution_setting: "true",
        limit: "500"
      })}`;
    const listUrl = (edge, fields) =>
      `${base}/${edge}?${new URLSearchParams({ access_token: META_ACCESS_TOKEN, fields, limit: "500" })}`;

    const [setIns, adIns, setList, adList] = await Promise.all([
      fetchAllInsights(insightUrl("adset", "adset_id,adset_name,spend,actions")),
      fetchAllInsights(insightUrl("ad", "ad_id,ad_name,adset_id,adset_name,spend,actions")),
      fetchPagedList(listUrl("adsets", "id,name,status")),
      fetchPagedList(listUrl("ads", "id,name,status,adset_id"))
    ]);

    const err = setIns.error || adIns.error || setList.error || adList.error;
    if (err) return res.status(502).json({ error: err });

    const sets = new Map();
    const touch = (id, name) => {
      if (!sets.has(id)) sets.set(id, { id, name: name || `Ad set ${id}`, status: "ACTIVE", row: null, ads: new Map() });
      return sets.get(id);
    };

    setList.rows.forEach((s) => {
      const x = touch(String(s.id), s.name);
      x.status = String(s.status || "ACTIVE").toUpperCase();
    });
    setIns.rows.forEach((r) => { touch(String(r.adset_id), r.adset_name).row = r; });
    adList.rows.forEach((a) => {
      if (!a.adset_id) return;
      touch(String(a.adset_id), "").ads.set(String(a.id), {
        id: String(a.id), name: a.name, status: String(a.status || "ACTIVE").toUpperCase(), row: null
      });
    });
    adIns.rows.forEach((r) => {
      const x = touch(String(r.adset_id), r.adset_name);
      const id = String(r.ad_id);
      const cur = x.ads.get(id) || { id, name: r.ad_name, status: "ACTIVE", row: null };
      cur.row = r;
      cur.name = cur.name || r.ad_name;
      x.ads.set(id, cur);
    });

    const bySpend = (a, b) => parseFloat(b.spend) - parseFloat(a.spend);
    const adsets = [];
    sets.forEach((s) => {
      const ads = Array.from(s.ads.values())
        .map((a) => ({ id: a.id, name: a.name || `Ad ${a.id}`, status: a.status, ...buildMetricRow(a.row, objective) }))
        .filter((a) => parseFloat(a.spend) > 0 || a.status === "ACTIVE")
        .sort(bySpend);
      const item = { id: s.id, name: s.name, status: s.status, ...buildMetricRow(s.row, objective), ads };
      if (parseFloat(item.spend) > 0 || item.status === "ACTIVE") adsets.push(item);
    });
    adsets.sort(bySpend);

    const v = { campaign_id: campaignId, date, adsets };
    detailCache.set(key, { t: Date.now(), v });
    if (detailCache.size > 200) detailCache.clear();
    res.json(v);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/daily-report", requireAuth, async (req, res) => {
  try {
    const rawDate = String(req.query.date || "");
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
    const scope = resolveScope(req.query.page_id || req.query.scope);
    const win = shiftWindow(targetDate, String(req.query.shift || "all"));

    const [{ data: msgs }, { data: replies }] = await Promise.all([
      supabase.from("messages").select("page_id, sender_id, status, phone_number, created_at"),
      supabase.from("replies").select("page_id, sender_id, moderator, reply_time, created_at, is_order_confirm")
    ]);

    const scopedMsgs = (msgs || []).filter((m) => matchesScope(m.page_id, scope.ids));
    const scopedReplies = (replies || []).filter((r) => matchesScope(r.page_id, scope.ids));

    const dayMsgs = scopedMsgs.filter((m) => dhakaDayFromIso(m.created_at) === targetDate);
    const priorCustSet = new Set(
      scopedMsgs
        .filter((m) => dhakaDayFromIso(m.created_at) < targetDate)
        .map((m) => `${m.page_id}:${m.sender_id}`)
    );

    const dayReplies = scopedReplies
      .filter((r) => replyDay(r) === targetDate)
      .sort((a, b) => Number(a.reply_time || 0) - Number(b.reply_time || 0));

    const repliedCustSetToday = new Set(dayReplies.map((r) => `${r.page_id}:${r.sender_id}`));

    const receivedCustSet = new Set();
    const returningCustSet = new Set();
    const repliedCustSet = new Set();
    const unreadCustSet = new Set();
    const readNoReplyCustSet = new Set();
    const phoneSet = new Set();

    for (const m of dayMsgs) {
      const ck = `${m.page_id}:${m.sender_id}`;
      receivedCustSet.add(ck);
      if (priorCustSet.has(ck)) returningCustSet.add(ck);
      if (m.status === "replied") repliedCustSet.add(ck);
      if (m.status === "unread") unreadCustSet.add(ck);
      if (m.status === "read" && !repliedCustSetToday.has(ck)) readNoReplyCustSet.add(ck);
      if (m.phone_number) phoneSet.add(m.phone_number);
    }

    const confirmCustSet = new Set();
    for (const r of dayReplies) {
      if (Number(r.is_order_confirm) === 1) {
        confirmCustSet.add(`${r.page_id}:${r.sender_id}`);
      }
    }

    const totalReceived = receivedCustSet.size;
    const totalRawMessages = dayMsgs.length;
    const returningCustomers = returningCustSet.size;
    const totalReplied = repliedCustSet.size;
    const unreadPending = unreadCustSet.size;
    const readNoReply = readNoReplyCustSet.size;
    const orderConfirms = confirmCustSet.size;
    const phoneCount = phoneSet.size;

    const isShift = win.key !== "all";
    const inShift = (t) => !isShift || (t >= win.startMs && t < win.endMs);

    const mergedByMod = new Map();
    const ensureMod = (rawMod) => {
      const modName = normalizeModeratorName(rawMod);
      if (!modName) return null;
      if (!mergedByMod.has(modName)) {
        mergedByMod.set(modName, {
          name: modName,
          total_conversations: 0,
          total_messages: 0,
          confirmed_orders: 0,
          phone_numbers: 0
        });
      }
      return mergedByMod.get(modName);
    };

    const firstByCustomer = new Map();
    let unattributedMessages = 0;

    for (const r of dayReplies) {
      const t =
        Number(r.reply_time) > 0
          ? Number(r.reply_time)
          : Date.parse(String(r.created_at || "")) || 0;
      const cur = ensureMod(r.moderator);

      if (!cur) {
        if (inShift(t)) unattributedMessages += 1;
        continue;
      }

      const custKey = `${r.page_id}:${r.sender_id}`;
      if (!firstByCustomer.has(custKey)) {
        firstByCustomer.set(custKey, { mod: cur.name, time: t });
      }

      if (inShift(t)) {
        cur.total_messages += 1;
        if (r.is_order_confirm) cur.confirmed_orders += 1;
      }
    }

    for (const info of firstByCustomer.values()) {
      if (inShift(info.time)) {
        const cur = ensureMod(info.mod);
        if (cur) cur.total_conversations += 1;
      }
    }

    const phoneSetByMod = new Map();
    for (const p of dayMsgs) {
      if (!p.phone_number) continue;
      const first = firstByCustomer.get(`${p.page_id}:${p.sender_id}`);
      if (!first || !inShift(first.time)) continue;
      if (!phoneSetByMod.has(first.mod)) phoneSetByMod.set(first.mod, new Set());
      phoneSetByMod.get(first.mod).add(p.phone_number);
    }
    for (const [modName, set] of phoneSetByMod.entries()) {
      const cur = ensureMod(modName);
      if (cur) cur.phone_numbers += set.size;
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
      confirmed_orders: m.confirmed_orders,
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
        total_phone_numbers: phoneCount,
        unattributed_messages: unattributedMessages
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

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await loadDbAliases();
  await seedDefaultSavedRepliesIfEmpty();
  await purgeOldEchoLogs();
});
