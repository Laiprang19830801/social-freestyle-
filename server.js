/**
 * server.js
 * LaiprangBrain & GeminiSearch - Freestyle Zone
 * สร้างและควบคุมโดย: แชมป์ (James Suersuwan) ร่วมกับ ClaudeMD
 * Node.js + Express + Helmet + Proxy API
 *
 * รันด้วย: npm install แล้ว npm start
 * ต้องมีไฟล์ .env (ก็อปจาก .env.example แล้วใส่ค่าจริง)
 */

require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieSession = require("cookie-session");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch");
const path = require("path");

const { WebSocketServer } = require("ws");
const http = require("http");

const { MembershipStore, TIERS } = require("./membership");
const { littleBrotherScan, bigBrotherScan, GuardianStats } = require("./aiGuardian");
const { LiveShopStore } = require("./liveShop");
const { SafetyTracker } = require("./safetyTracker");
const { BehaviorBaseline } = require("./behaviorBaseline");

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

const membership = new MembershipStore();
const guardianStats = new GuardianStats();
const liveShop = new LiveShopStore();
const safetyTracker = new SafetyTracker();
const behaviorBaseline = new BehaviorBaseline();

/* ---------------------------------------------------------------------- */
/* ความปลอดภัย: Helmet + CORS + Rate limit                                */
/* ---------------------------------------------------------------------- */

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // 'unsafe-inline' ไว้เผื่อ CSS variables inline; เอาออกได้ถ้าย้ายทั้งหมดไปไฟล์ .css
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // เผื่อโหลดรูปจาก CDN โซเชียลมีเดียภายนอก
    hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  })
);

app.use(
  cors({
    origin: IS_PROD ? [] /* ใส่โดเมนจริงของหน้าเว็บ production ตรงนี้ */ : true,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

app.use(
  cookieSession({
    name: "lpb_session",
    secret: process.env.SESSION_SECRET || "dev-only-secret-เปลี่ยนก่อนขึ้นจริง",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
  })
);

// จำกัดจำนวน request ทั่วไป กันสแปม/บอท
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "ยิง request ถี่เกินไป ลองใหม่อีกครั้งในอีกสักครู่" },
});
app.use("/api/", globalLimiter);

// รัดกุมกว่านั้นสำหรับ endpoint ที่ยิงออกไปยัง API ภายนอก (โซเชียลมีเดีย/Gemini) เพราะมี cost
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "เรียก proxy ถี่เกินไป รอ 1 นาทีแล้วลองใหม่" },
});

/* ---------------------------------------------------------------------- */
/* Middleware: ระบุตัวผู้ใช้แบบง่ายๆ (mock auth) ผ่าน session               */
/* โปรดักชันจริง: แทนที่ด้วยระบบ auth จริง เช่น JWT + OAuth ของแต่ละแพลตฟอร์ม */
/* ---------------------------------------------------------------------- */

app.use((req, res, next) => {
  if (!req.session.userId) {
    req.session.userId = "guest_" + Math.random().toString(36).slice(2, 10);
  }
  req.userId = req.session.userId;
  next();
});

/* ---------------------------------------------------------------------- */
/* Static frontend                                                        */
/* ---------------------------------------------------------------------- */

app.use(express.static(path.join(__dirname, "public")));

/* ---------------------------------------------------------------------- */
/* API: Membership                                                        */
/* ---------------------------------------------------------------------- */

app.get("/api/me", (req, res) => {
  res.json({
    userId: req.userId,
    membership: membership.publicSummary(req.userId),
    tiers: Object.values(TIERS).map((t) => ({
      key: t.key,
      label: t.label,
      price: t.price,
      canSelfPromote: t.canSelfPromote,
      dailyPostLimit: t.dailyPostLimit,
    })),
  });
});

app.post("/api/membership/upgrade", (req, res) => {
  const { tier } = req.body;
  try {
    membership.setTier(req.userId, tier);
    res.json({ ok: true, membership: membership.publicSummary(req.userId) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* ---------------------------------------------------------------------- */
/* API: Posting + VIP Self-Promotion                                      */
/* ---------------------------------------------------------------------- */

app.post("/api/posts", async (req, res) => {
  const { text = "", links = [] } = req.body;

  const muteStatus = safetyTracker.isMuted(req.userId);
  if (muteStatus.muted) {
    return res.status(403).json({
      ok: false,
      error: `บัญชีนี้ถูกจำกัดการโพสต์ชั่วคราว เพราะระบบตรวจพบพฤติกรรมเสี่ยงซ้ำ ลองใหม่อีกครั้งในอีก ${Math.ceil(
        muteStatus.remainingMs / 60000
      )} นาที`,
    });
  }

  const check = membership.can(req.userId, "post");
  if (!check.allowed) return res.status(403).json({ ok: false, error: check.reason });

  // ทุกโพสต์ผ่าน AI พี่น้องก่อนเผยแพร่เสมอ (กฎเหล็ก: ห้ามทำให้ใครเดือดร้อน)
  const cfg = membership.getTierConfig(req.userId);
  const fullText = [text, ...links].join(" ");
  const scanResult =
    cfg.aiBrotherLevel === "big" ? await bigBrotherScan(fullText, fetch) : littleBrotherScan(fullText);
  guardianStats.record(scanResult);

  if (scanResult.verdict !== "safe") {
    safetyTracker.recordViolation(req.userId, scanResult);
  }

  if (scanResult.verdict === "high_risk") {
    return res.status(422).json({
      ok: false,
      error: "โพสต์นี้ถูกระงับ เพราะ AI พี่น้องตรวจพบความเสี่ยงสูง (อาจเป็นฟิชชิ่ง/มัลแวร์/พฤติกรรมล่อลวง)",
      scan: scanResult,
    });
  }

  membership.recordPost(req.userId);

  // สัญญาณพฤติกรรมผิดปกติ (advisory เท่านั้น) — ไม่ block โพสต์ แค่ขึ้น flag ให้แอดมินดูใน dashboard
  const anomalies = behaviorBaseline.recordAndCheck(req.userId, fullText);
  anomalies.forEach((a) => guardianStats.recordAnomaly(req.userId, a));

  res.json({
    ok: true,
    post: { text, links, createdAt: new Date().toISOString() },
    scan: scanResult,
  });
});

app.post("/api/posts/self-promote", (req, res) => {
  const check = membership.can(req.userId, "selfPromote");
  if (!check.allowed) return res.status(403).json({ ok: false, error: check.reason });

  membership.recordSelfPromote(req.userId);
  const cfg = membership.getTierConfig(req.userId);

  res.json({
    ok: true,
    message: "โปรโมทโพสต์สำเร็จ การมองเห็นเพิ่มขึ้นทันที",
    feedBoost: cfg.feedBoost,
  });
});

/* ---------------------------------------------------------------------- */
/* API: AI Guardian dashboard stats                                       */
/* ---------------------------------------------------------------------- */

app.get("/api/guardian/stats", (req, res) => {
  const check = membership.can(req.userId, "aiBigBrother");
  res.json({
    ok: true,
    hasBigBrother: check.allowed,
    stats: guardianStats.summary(),
  });
});

// หมายเหตุ: endpoint นี้ควรจำกัดเฉพาะแอดมิน/เจ้าของแพลตฟอร์มเท่านั้นในโปรดักชันจริง
// ตอนนี้ยังไม่มีระบบสิทธิ์แอดมินจริง (ดู README ข้อ "ระบบล็อกอินจริง")
app.get("/api/guardian/flagged", (req, res) => {
  res.json({ ok: true, flagged: safetyTracker.listFlagged() });
});

app.post("/api/guardian/scan", async (req, res) => {
  const { content = "" } = req.body;
  const cfg = membership.getTierConfig(req.userId);
  const result =
    cfg.aiBrotherLevel === "big" ? await bigBrotherScan(content, fetch) : littleBrotherScan(content);
  guardianStats.record(result);
  res.json({ ok: true, result });
});

/* ---------------------------------------------------------------------- */
/* API: Live Shop — ห้องไลฟ์ขายของ                                        */
/* วิดีโอจริงต้องต่อ third-party streaming provider เอง (ดู README)         */
/* ที่นี่จัดการแค่ metadata ของห้อง + สินค้าปักหมุด ส่วนแชทสดไปทาง WebSocket   */
/* ---------------------------------------------------------------------- */

app.get("/api/live/sessions", (req, res) => {
  res.json({ ok: true, sessions: liveShop.listActive() });
});

app.post("/api/live/sessions", (req, res) => {
  const { title } = req.body;
  const session = liveShop.createSession(req.userId, title);
  res.json({
    ok: true,
    session: { id: session.id, title: session.title, startedAt: session.startedAt },
  });
});

app.post("/api/live/sessions/:id/end", (req, res) => {
  const result = liveShop.endSession(req.params.id, req.userId);
  if (!result.ok) return res.status(403).json(result);
  res.json(result);
});

app.post("/api/live/sessions/:id/products", (req, res) => {
  const session = liveShop.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: "ไม่พบห้องไลฟ์นี้" });
  if (session.hostUserId !== req.userId) {
    return res.status(403).json({ ok: false, error: "เฉพาะเจ้าของไลฟ์เท่านั้นที่ปักหมุดสินค้าได้" });
  }
  const item = liveShop.addProduct(req.params.id, req.body);
  res.json({ ok: true, product: item });
});

/* ---------------------------------------------------------------------- */
/* API: Social media proxy (เก็บ client key/secret ไว้ฝั่ง server เท่านั้น) */
/* client ไม่มีทางเห็น API key จริงเลย ยิงผ่าน endpoint พวกนี้แทน            */
/* ---------------------------------------------------------------------- */

app.get("/api/proxy/status", proxyLimiter, (req, res) => {
  // บอกฝั่ง frontend ว่าแพลตฟอร์มไหนตั้งค่า key พร้อมใช้งานแล้วบ้าง
  res.json({
    tiktok: Boolean(process.env.TIKTOK_CLIENT_KEY),
    instagram: Boolean(process.env.IG_APP_ID),
    facebook: Boolean(process.env.FB_APP_ID),
    x: Boolean(process.env.X_BEARER_TOKEN),
    youtube: Boolean(process.env.YOUTUBE_API_KEY),
    line: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
  });
});

/**
 * ตัวอย่าง proxy endpoint: ค้นหาวิดีโอสาธารณะจาก YouTube Data API v3
 */
app.get("/api/proxy/youtube/search", proxyLimiter, async (req, res) => {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "ยังไม่ได้ตั้งค่า YOUTUBE_API_KEY ใน .env — ใส่ค่าจริงก่อนใช้งาน endpoint นี้",
    });
  }
  const q = encodeURIComponent(req.query.q || "");
  try {
    const resp = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&q=${q}&key=${key}`
    );
    const data = await resp.json();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: "เรียก YouTube API ไม่สำเร็จ: " + err.message });
  }
});

/**
 * ตัวอย่าง proxy endpoint: ส่งข้อความผ่าน LINE Messaging API (push message)
 * หมายเหตุ: LINE ไม่มี public "feed" ให้ดึงเหมือนแพลตฟอร์มอื่น เพราะ LINE เป็นแชท/官方账号
 * เอาไว้ใช้ต่อ LINE Official Account สำหรับแจ้งเตือนลูกค้าที่ทักมาแทน
 */
app.post("/api/proxy/line/push", proxyLimiter, async (req, res) => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return res.status(503).json({
      ok: false,
      error: "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ใน .env — ใส่ค่าจริงก่อนใช้งาน endpoint นี้",
    });
  }
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ ok: false, error: "ต้องระบุ to และ text" });

  try {
    const resp = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
    const data = await resp.json().catch(() => ({}));
    res.json({ ok: resp.ok, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: "เรียก LINE API ไม่สำเร็จ: " + err.message });
  }
});

/**
 * ตัวอย่าง proxy endpoint: ดึงข้อมูลสาธารณะจาก X (Twitter) API v2
 * แพลตฟอร์มอื่น (TikTok Display API, IG Graph API, FB Graph API) ทำรูปแบบเดียวกัน
 * คือประกาศ route ที่นี่ แล้วยิง fetch() ออกไปโดยแนบ key จาก process.env เท่านั้น
 * ไม่เคยส่ง key ไปให้ client โดยตรง
 */
app.get("/api/proxy/x/search", proxyLimiter, async (req, res) => {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    return res.status(503).json({
      ok: false,
      error: "ยังไม่ได้ตั้งค่า X_BEARER_TOKEN ใน .env — ใส่ค่าจริงก่อนใช้งาน endpoint นี้",
    });
  }
  const q = encodeURIComponent(req.query.q || "");
  try {
    const resp = await fetch(`https://api.twitter.com/2/tweets/search/recent?query=${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: "เรียก X API ไม่สำเร็จ: " + err.message });
  }
});

/* ---------------------------------------------------------------------- */
/* Fallback: ส่ง index.html สำหรับทุก route ที่ไม่ match (SPA-style)        */
/* ---------------------------------------------------------------------- */

app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------------------------------------------------------------------- */
/* Error handler กลาง                                                     */
/* ---------------------------------------------------------------------- */

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์" });
});

/* ---------------------------------------------------------------------- */
/* WebSocket: แชทไลฟ์ (real-time) — ต่อกับ liveShop session                 */
/* URL รูปแบบ: ws://host/ws/live/<sessionId>                               */
/* ทุกข้อความผ่าน AI พี่น้องสแกนก่อนกระจายเสมอ (กฎเหล็ก: ห้ามทำให้ใครเดือดร้อน)  */
/* เนื้อหาการซื้อขาย/การตกลงกันเองระหว่างผู้ใช้ เราไม่เข้าไปยุ่ง — สแกนแค่ภัยคุกคาม */
/* ---------------------------------------------------------------------- */

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// sessionId -> Set<ws>
const liveRooms = new Map();

const wsChatLimiter = new Map(); // ws -> { count, windowStart }
function isChatRateLimited(ws) {
  const now = Date.now();
  const rec = wsChatLimiter.get(ws) || { count: 0, windowStart: now };
  if (now - rec.windowStart > 10_000) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count += 1;
  wsChatLimiter.set(ws, rec);
  return rec.count > 15; // จำกัด 15 ข้อความ / 10 วิ ต่อการเชื่อมต่อ กันสแปมแชทไลฟ์
}

httpServer.on("upgrade", (req, socket, head) => {
  const match = req.url.match(/^\/ws\/live\/([a-zA-Z0-9_]+)/);
  if (!match) {
    socket.destroy();
    return;
  }
  const sessionId = match[1];
  if (!liveShop.get(sessionId)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.sessionId = sessionId;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const sessionId = ws.sessionId;
  const session = liveShop.get(sessionId);

  if (!liveRooms.has(sessionId)) liveRooms.set(sessionId, new Set());
  liveRooms.get(sessionId).add(ws);
  session.viewers.add(ws);

  broadcast(sessionId, { type: "viewer_count", count: session.viewers.size });

  ws.on("message", async (raw) => {
    if (isChatRateLimited(ws)) {
      ws.send(JSON.stringify({ type: "error", error: "ส่งข้อความถี่เกินไป ใจเย็นๆ ก่อนนะ" }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (payload.type !== "chat" || !payload.text) return;

    const chatUserId = payload.userId || "guest";
    const muteStatus = safetyTracker.isMuted(chatUserId);
    if (muteStatus.muted) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: `ถูกจำกัดการแชทชั่วคราว ลองใหม่ในอีก ${Math.ceil(muteStatus.remainingMs / 60000)} นาที`,
        })
      );
      return;
    }

    const text = String(payload.text).slice(0, 500);
    const scan = littleBrotherScan(text); // ใช้ LittleBrother เพราะต้องเร็วแบบ real-time
    guardianStats.record(scan);

    if (scan.verdict !== "safe") {
      const result = safetyTracker.recordViolation(chatUserId, scan);
      if (result.action === "flagged_for_review") {
        ws.send(
          JSON.stringify({
            type: "blocked",
            error: "ข้อความนี้ถูกบล็อกและส่งให้แอดมินตรวจสอบ เพราะตรวจพบพฤติกรรมเสี่ยงร้ายแรงหรือทำซ้ำหลายครั้ง",
          })
        );
        return;
      }
    }

    if (scan.verdict === "high_risk") {
      ws.send(
        JSON.stringify({
          type: "blocked",
          error: "ข้อความนี้ถูกบล็อก เพราะ AI พี่น้องตรวจพบความเสี่ยงสูง (ลิงก์/ข้อความต้องสงสัยว่าเป็นการหลอกลวง)",
        })
      );
      return;
    }

    const chatMessage = {
      type: "chat",
      userId: chatUserId,
      text,
      verdict: scan.verdict, // "safe" หรือ "suspicious" (ยังปล่อยผ่านแต่ติดป้ายเตือนไว้)
      sentAt: new Date().toISOString(),
    };
    liveShop.addChatMessage(sessionId, chatMessage);
    broadcast(sessionId, chatMessage);

    // สัญญาณพฤติกรรมผิดปกติ (advisory เท่านั้น) — ไม่บล็อกแชท แค่ขึ้น flag ให้แอดมินดู
    const anomalies = behaviorBaseline.recordAndCheck(chatUserId, text);
    anomalies.forEach((a) => guardianStats.recordAnomaly(chatUserId, a));
  });

  ws.on("close", () => {
    liveRooms.get(sessionId)?.delete(ws);
    session.viewers.delete(ws);
    wsChatLimiter.delete(ws);
    broadcast(sessionId, { type: "viewer_count", count: session.viewers.size });
  });
});

function broadcast(sessionId, data) {
  const room = liveRooms.get(sessionId);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const client of room) {
    if (client.readyState === 1 /* OPEN */) client.send(msg);
  }
}

httpServer.listen(PORT, () => {
  console.log(`LaiprangBrain & GeminiSearch กำลังรันที่ http://localhost:${PORT}`);
});
