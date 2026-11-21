"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createModeratorInboxRouter(deps) {
  const {
    db,
    stmts,
    MODERATORS,
    BUCKETS,
    PAGE_NAMES,
    META_API_VERSION,
    META_ACCESS_TOKEN,
    uploadDir,
    dhakaDate,
    resolveScope,
    pageClause,
    groupOf,
    listSavedRepliesFor,
    normalizeModeratorName,
    registerAlias,
    parseAdJson,
    adNeedsEnrich,
    enrichAndStoreAd,
    syncCustomerAndAdFromGraph,
    sendFacebookPayload,
    httpsGetJson,
    requireModAuth,
    requireDebugAuth,
    DAY_M,
    DAY_R
  } = deps;

  const router = express.Router();

  function sentMessagesByModerator(day, ids) {
    const pcR = pageClause(ids, "r.page_id");
    const rows = db
      .prepare(
        `SELECT r.moderator, COUNT(*) AS msgs, COUNT(DISTINCT r.page_id || ':' || r.sender_id) AS custs
         FROM replies r
         WHERE ${DAY_R} = ?${pcR.sql}
           AND r.moderator IS NOT NULL AND r.moderator != ''
         GROUP BY r.moderator`
      )
      .all(day, ...pcR.params);

    const map = new Map();
    for (const r of rows) {
      const name = normalizeModeratorName(r.moderator);
      if (!name) continue;
      const cur = map.get(name) || { msgs: 0, custs: 0 };
      cur.msgs += r.msgs;
      cur.custs += r.custs;
      map.set(name, cur);
    }
    return map;
  }

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

  async function syncMetaSavedRepliesNow(pageTokens) {
    let imported = 0;
    const errors = [];

    const tokenEntries = Object.entries(pageTokens || {}).filter(([, t]) => Boolean(t));
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
      const group = groupOf(pageId) || "all";
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
        stmts.upsertSavedReply.run(srId, title, msgTxt, "meta", PAGE_NAMES[pageId] || pageId, now, group);
        fetchedByGroup.get(group).add(srId);
        imported += 1;
      }
    }

    for (const [group, idSet] of fetchedByGroup.entries()) {
      if (failedGroups.has(group)) continue;
      const existing = db
        .prepare(`SELECT id FROM saved_replies WHERE source = 'meta' AND page_group = ?`)
        .all(group);
      for (const row of existing) {
        if (!idSet.has(row.id)) stmts.deleteSavedReply.run(row.id);
      }
    }

    return { imported, errors };
  }

  router.get("/api/echo-log", requireDebugAuth, (req, res) => {
    const rows = db
      .prepare(`SELECT page_id, customer_id, text, from_id, from_name, app_id, via, moderator, created_ms FROM echo_log ORDER BY id DESC LIMIT 150`)
      .all();
    res.json({ count: rows.length, rows });
  });

  router.get("/api/mod-alias", requireDebugAuth, (req, res) => {
    const alias = String(req.query.alias || "").trim();
    const modName = normalizeModeratorName(String(req.query.moderator || ""));
    const known = MODERATORS.find((m) => m.name === modName);
    if (!alias || !known) {
      return res.status(400).json({ error: "alias আর সঠিক moderator নাম দিন", moderators: MODERATORS.map((m) => m.name) });
    }
    db.prepare(`INSERT INTO mod_aliases (alias, moderator) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET moderator = excluded.moderator`).run(alias, known.name);
    registerAlias(alias, known.name);
    const upd = db
      .prepare(`UPDATE replies SET moderator = ? WHERE message_id IN (SELECT mid FROM echo_log WHERE from_id = ?)`)
      .run(known.name, alias);
    res.json({ ok: true, alias, moderator: known.name, old_replies_fixed: upd.changes });
  });

  router.get("/api/saved-replies", requireModAuth, (req, res) => {
    res.json({ replies: listSavedRepliesFor(req.query.page_id) });
  });

  router.post("/api/saved-replies", requireModAuth, (req, res) => {
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

    stmts.upsertSavedReply.run(id, title, text, "shared", createdBy, now, group);
    res.json({
      ok: true,
      reply: { id, title, text, source: "shared", created_by: createdBy, updated_at: now, page_group: group }
    });
  });

  router.delete("/api/saved-replies/:id", requireModAuth, (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Invalid ID" });
    stmts.deleteSavedReply.run(id);
    res.json({ ok: true, id });
  });

  router.post("/api/saved-replies/sync-meta", requireModAuth, async (req, res) => {
    try {
      const { imported, errors } = await syncMetaSavedRepliesNow(deps.PAGE_TOKENS);
      const pageRef = (req.body && req.body.page_id) || req.query.page_id;
      res.json({ ok: true, imported, errors, replies: listSavedRepliesFor(pageRef) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/mod/list", (req, res) => {
    res.json({ moderators: MODERATORS.map((m) => m.name) });
  });

  router.post("/api/mod/batch", requireModAuth, async (req, res) => {
    try {
      const { moderator, requestNew, pageFilter, bucket, date } = req.body;
      if (!moderator) return res.status(400).json({ error: "Moderator name required" });

      const todayStr = dhakaDate();
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : todayStr;
      const isToday = day === todayStr;

      const activeBucket = BUCKETS.includes(bucket) ? bucket : "pending";
      const scope = resolveScope(pageFilter || "all");
      const pcM = pageClause(scope.ids, "m.page_id");
      const pcA = pageClause(scope.ids, "a.page_id");

      const getBucketCustomers = (targetBucket) => {
        const orderSql =
          targetBucket === "pending" ? "MIN(m.id) ASC" : "(unread_count > 0) DESC, last_time DESC";
        return db.prepare(`
          SELECT 
            m.page_id,
            m.sender_id,
            COALESCE(NULLIF(MAX(c.name), ''), 'Customer_' || substr(m.sender_id, -4)) as customer_name,
            MAX(c.profile_pic) as profile_pic,
            COALESCE(MAX(c.ad_info), MAX(m.ad_info)) as ad_info,
            (SELECT lm.message_text FROM messages lm
               WHERE lm.page_id = m.page_id AND lm.sender_id = m.sender_id
               ORDER BY COALESCE(lm.message_time, 0) DESC, lm.id DESC LIMIT 1) as last_message,
            MAX(m.message_time) as last_time,
            COUNT(m.id) as msg_count,
            (SELECT COUNT(*) FROM messages um
               WHERE um.page_id = m.page_id AND um.sender_id = m.sender_id
                 AND COALESCE(um.message_time, 0) > COALESCE(
                   (SELECT rd.read_at FROM mod_reads rd WHERE rd.page_id = m.page_id AND rd.sender_id = m.sender_id), 0)
            ) as unread_count
          FROM messages m
          JOIN moderator_assignments a 
            ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
          LEFT JOIN customers c ON m.page_id = c.page_id AND m.sender_id = c.sender_id
          WHERE a.moderator = ?
            AND COALESCE(NULLIF(a.bucket, ''), 'pending') = ?
            AND ${DAY_M} = ?
            ${pcM.sql}
          GROUP BY m.page_id, m.sender_id
          ORDER BY ${orderSql}
        `).all(day, moderator, targetBucket, day, ...pcM.params);
      };

      if (isToday && (activeBucket === "pending" || requestNew)) {
        const pcPend = pageClause(scope.ids, "a.page_id");
        const totalPending = db.prepare(`
          SELECT COUNT(DISTINCT a.page_id || ':' || a.sender_id) AS cnt
          FROM moderator_assignments a
          JOIN messages m ON m.page_id = a.page_id AND m.sender_id = a.sender_id AND ${DAY_M} = ?
          WHERE a.day = ? AND a.moderator = ?
            AND COALESCE(NULLIF(a.bucket, ''), 'pending') = 'pending'
            ${pcPend.sql}
        `).get(todayStr, todayStr, moderator, ...pcPend.params).cnt;

        const slotsNeeded = 10 - totalPending;
        if (slotsNeeded > 0) {
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
          `).all(todayStr, todayStr, ...pcM.params, slotsNeeded);

          const assignTransaction = db.transaction((list) => {
            const now = Date.now();
            for (const item of list) {
              stmts.assignModerator.run(item.page_id, item.sender_id, todayStr, moderator, now);
            }
          });
          assignTransaction(unassignedCustomers);
        }
      }

      const currentList = getBucketCustomers(activeBucket);

      const missingProfiles = currentList.filter(
        (q) => !q.profile_pic || q.customer_name.startsWith("Customer_")
      );
      if (missingProfiles.length > 0) {
        Promise.all(
          missingProfiles.slice(0, 5).map((q) => syncCustomerAndAdFromGraph(q.page_id, q.sender_id))
        ).catch(() => {});
      }

      const bucketRows = db.prepare(`
        SELECT b,
               COUNT(*) AS cust,
               SUM(CASE WHEN u > 0 THEN 1 ELSE 0 END) AS ucust,
               SUM(u) AS umsgs
        FROM (
          SELECT COALESCE(NULLIF(a.bucket, ''), 'pending') AS b,
                 a.page_id, a.sender_id,
                 (SELECT COUNT(*) FROM messages um
                    WHERE um.page_id = a.page_id AND um.sender_id = a.sender_id
                      AND COALESCE(um.message_time, 0) > COALESCE(
                        (SELECT rd.read_at FROM mod_reads rd WHERE rd.page_id = a.page_id AND rd.sender_id = a.sender_id), 0)
                 ) AS u
          FROM moderator_assignments a
          WHERE a.day = ? AND a.moderator = ? ${pcA.sql}
            AND EXISTS (
              SELECT 1 FROM messages m
              WHERE m.page_id = a.page_id AND m.sender_id = a.sender_id AND ${DAY_M} = ?
            )
        )
        GROUP BY b
      `).all(day, moderator, ...pcA.params, day);

      const counts = {};
      const unread = {};
      BUCKETS.forEach((b) => { counts[b] = 0; unread[b] = { customers: 0, messages: 0 }; });
      bucketRows.forEach((r) => {
        if (counts[r.b] === undefined) return;
        counts[r.b] = r.cust;
        if (isToday) {
          unread[r.b] = { customers: r.ucust || 0, messages: r.umsgs || 0 };
        }
      });

      const assignedTotal = BUCKETS.reduce((s, b) => s + counts[b], 0);
      const sentMap = sentMessagesByModerator(day, scope.ids);
      const myName = normalizeModeratorName(moderator) || moderator;
      const sentMessages = (sentMap.get(myName) || { msgs: 0 }).msgs;

      const globalUnassigned = db.prepare(`
        SELECT COUNT(DISTINCT m.page_id || ':' || m.sender_id) as count
        FROM messages m
        LEFT JOIN moderator_assignments a 
          ON a.page_id = m.page_id AND a.sender_id = m.sender_id AND a.day = ?
        WHERE a.moderator IS NULL
          AND m.status != 'replied'
          AND ${DAY_M} = ?
          ${pcM.sql}
      `).get(todayStr, todayStr, ...pcM.params).count;

      res.json({
        moderator,
        day,
        is_today: isToday,
        bucket: activeBucket,
        counts,
        unread,
        assigned_total: assignedTotal,
        sent_messages: sentMessages,
        queue: currentList.map((q) => ({
          ...q,
          unread_count: isToday ? q.unread_count : 0,
          ad_data: parseAdJson(q.ad_info),
          page_name: PAGE_NAMES[q.page_id] || "Page"
        })),
        global_unassigned: globalUnassigned
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/mod/classify", requireModAuth, (req, res) => {
    try {
      const { page_id, sender_id, moderator, bucket } = req.body;
      if (!page_id || !sender_id || !moderator || !BUCKETS.includes(bucket)) {
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

  router.get("/api/mod/chat", requireModAuth, async (req, res) => {
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

      let adData = parseAdJson(custRow && custRow.ad_info);
      if (!adData) {
        const withAd = incoming.filter((i) => i.ad_info).map((i) => parseAdJson(i.ad_info)).filter(Boolean);
        if (withAd.length) adData = withAd[withAd.length - 1];
      }

      if (adData && adNeedsEnrich(adData)) {
        try {
          adData = await enrichAndStoreAd(String(page_id), String(sender_id), adData);
        } catch (e) {}
      }

      if (!custRow || !custRow.profile_pic) {
        syncCustomerAndAdFromGraph(page_id, sender_id).catch(() => {});
      }

      try {
        const maxIncoming = incoming.reduce((mx, i) => Math.max(mx, Number(i.time) || 0), 0);
        db.prepare(`
          INSERT INTO mod_reads (page_id, sender_id, read_at) VALUES (?, ?, ?)
          ON CONFLICT(page_id, sender_id) DO UPDATE SET read_at = excluded.read_at
        `).run(String(page_id), String(sender_id), Math.max(Date.now(), maxIncoming));
      } catch (e) {}

      const merged = [...incoming, ...outgoing]
        .map((m) => ({ sender: m.sender, text: m.text, image_url: m.image_url, time: m.time, moderator: m.moderator }))
        .sort((a, b) => (a.time || 0) - (b.time || 0));

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

  router.get("/api/mod/stats", requireModAuth, (req, res) => {
    try {
      const rawDate = String(req.query.date || "");
      const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : dhakaDate();
      const scope = resolveScope(req.query.page_id || req.query.scope || "all");
      const pcA = pageClause(scope.ids, "a.page_id");

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

      const assignRows = db.prepare(`
        SELECT a.moderator, COALESCE(NULLIF(a.bucket, ''), 'pending') AS b,
               COUNT(DISTINCT a.page_id || ':' || a.sender_id) AS cnt
        FROM moderator_assignments a
        WHERE a.day = ? ${pcA.sql}
          AND EXISTS (
            SELECT 1 FROM messages m
            WHERE m.page_id = a.page_id AND m.sender_id = a.sender_id AND ${DAY_M} = ?
          )
        GROUP BY a.moderator, b
      `).all(day, ...pcA.params, day);

      for (const r of assignRows) {
        const row = getRow(r.moderator);
        if (!row) continue;
        row.assigned += r.cnt;
        if (row[r.b] !== undefined) row[r.b] += r.cnt;
      }

      const sentMap = sentMessagesByModerator(day, scope.ids);
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

  router.post("/api/mod/send", requireModAuth, async (req, res) => {
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
      const isConfirm = /your\s+order\s+is\s+confirm(?:ed)?/i.test(cleanText) ? 1 : 0;

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

  setTimeout(() => { syncMetaSavedRepliesNow(deps.PAGE_TOKENS).catch(() => {}); }, 8000);
  setInterval(() => { syncMetaSavedRepliesNow(deps.PAGE_TOKENS).catch(() => {}); }, 10 * 60 * 1000).unref();

  return router;
}

module.exports = { createModeratorInboxRouter };
