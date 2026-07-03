/**
 * aiGuardian.js
 * ระบบ AI พี่น้อง (BigBrother / LittleBrother)
 *
 * LittleBrother = สแกนแบบ heuristic เร็วๆ (regex/keyword/URL pattern) ทำงานได้ทันทีไม่ต้องพึ่ง API ภายนอก
 * BigBrother    = LittleBrother + (ถ้ามี GEMINI_API_KEY) ส่งข้อความ/ลิงก์ที่น่าสงสัยไปให้ Gemini
 *                 ช่วยวิเคราะห์เชิงลึกอีกชั้น แล้วรวมผลเป็นรายงาน
 *
 * หมายเหตุสำคัญ: นี่คือ "จุดเริ่มต้น" ของระบบป้องกันภัย ไม่ใช่ระบบสแกนมัลแวร์ระดับ production
 * ถ้าจะขึ้นจริงกับผู้ใช้จำนวนมาก ควรต่อกับบริการ threat-intel จริง เช่น Google Safe Browsing API
 * หรือ VirusTotal API เพิ่มเติม โค้ดด้านล่างเว้น hook ไว้ให้ต่อได้ที่ฟังก์ชัน checkAgainstSafeBrowsing()
 */

const SUSPICIOUS_KEYWORDS = [
  "ยืนยันบัญชีด่วน",
  "คลิกลิงก์นี้ด่วน",
  "บัญชีของคุณจะถูกระงับ",
  "แจกฟรี100%",
  "โอนเงินก่อนได้ของรางวัล",
  "verify your account now",
  "your account will be suspended",
  "claim your prize",
  "free followers",
  "urgent action required",
];

const SUSPICIOUS_URL_PATTERNS = [
  /bit\.ly\//i,
  /tinyurl\.com\//i,
  /[a-z0-9-]+\.(xyz|top|click|country|gq|tk)\b/i, // โดเมนกลุ่มเสี่ยงสูงที่มิจฉาชีพชอบใช้
  /paypa1|faceb00k|instagr4m|tikt0k/i, // typo-squatting ปลอมแบรนด์
];

/**
 * รูปแบบพฤติกรรมเสี่ยงเชิงล่อลวง/แสวงหาประโยชน์จากเด็ก (grooming-pattern)
 * เก็บไว้แค่ "ระดับรูปแบบพฤติกรรม" (behavior category) ไม่ใช่คลังคำพูดสำเร็จรูป
 * เพื่อไม่ให้กลายเป็นสคริปต์ที่คนไม่หวังดีเอาไปใช้เลี่ยงระบบได้ง่ายๆ
 * นี่คือ "จุดเริ่มต้น" ของการตรวจจับเท่านั้น — แนะนำให้เสริมทีมมนุษย์ตรวจสอบ/รายงานจริงคู่กันเสมอ
 * สำหรับแพลตฟอร์มที่มีเด็กใช้งานจริง ควรพิจารณาต่อบริการตรวจจับระดับ enterprise เพิ่มเติมด้วย
 */
const GROOMING_PATTERN_CATEGORIES = [
  {
    category: "move_off_platform",
    label: "ชวนย้ายไปคุยแอปอื่นแบบส่วนตัว",
    patterns: [/ไลน์ไอดี|ไปคุยไลน์|add line|คุยส่วนตัวดีกว่า/i],
  },
  {
    category: "secrecy_pressure",
    label: "ขอให้ปิดเป็นความลับจากพ่อแม่/ผู้ปกครอง",
    patterns: [/อย่าบอกพ่อแม่|เก็บเป็นความลับนะ|อย่าให้ใครรู้เรื่องนี้/i],
  },
  {
    category: "personal_media_request",
    label: "ขอรูป/ข้อมูลส่วนตัวที่ไม่เหมาะสม",
    patterns: [/ส่งรูปตัวเองมาให้ดูหน่อย|ถ่ายรูป.{0,10}ส่งมา/i],
  },
];

function groomingPatternScan(text) {
  const hits = [];
  for (const group of GROOMING_PATTERN_CATEGORIES) {
    for (const pattern of group.patterns) {
      if (pattern.test(text || "")) {
        hits.push({ type: "grooming_pattern", category: group.category, label: group.label });
        break; // นับแค่ 1 ครั้งต่อหมวด ไม่ต้องนับซ้ำทุก pattern ย่อยในหมวดเดียวกัน
      }
    }
  }
  return hits;
}

function scoreText(text) {
  let score = 0;
  const hits = [];
  const lower = (text || "").toLowerCase();

  for (const kw of SUSPICIOUS_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      score += 2;
      hits.push({ type: "keyword", value: kw });
    }
  }

  for (const pattern of SUSPICIOUS_URL_PATTERNS) {
    if (pattern.test(text || "")) {
      score += 3;
      hits.push({ type: "url_pattern", value: pattern.toString() });
    }
  }

  // ลิงก์เยอะผิดปกติในข้อความเดียว = น่าสงสัย
  const urlCount = (text.match(/https?:\/\/[^\s]+/g) || []).length;
  if (urlCount >= 3) {
    score += 1;
    hits.push({ type: "many_links", value: urlCount });
  }

  // รูปแบบพฤติกรรมเสี่ยงล่อลวงเด็ก ให้น้ำหนักสูงสุด เพราะผลกระทบร้ายแรงกว่าฟิชชิ่งทั่วไป
  const groomingHits = groomingPatternScan(text);
  for (const h of groomingHits) {
    score += 4;
    hits.push(h);
  }

  return { score, hits };
}

/**
 * Hook สำหรับต่อ Google Safe Browsing API จริงในอนาคต
 * ตอนนี้เป็น stub ที่คืนค่า "ไม่พบข้อมูล" เสมอ เพื่อไม่ให้ระบบ error ถ้ายังไม่ได้ตั้งค่า key
 */
async function checkAgainstSafeBrowsing(url) {
  // TODO: ต่อ Google Safe Browsing API ที่นี่เมื่อพร้อม (ต้องใช้ API key แยกต่างหาก)
  return { checked: false, malicious: null };
}

/** LittleBrother: สแกนเร็ว ไม่ต้องพึ่ง network */
function littleBrotherScan(content) {
  const { score, hits } = scoreText(content);
  let verdict = "safe";
  if (score >= 5) verdict = "high_risk";
  else if (score >= 2) verdict = "suspicious";

  return {
    engine: "LittleBrother",
    verdict,
    score,
    hits,
    scannedAt: new Date().toISOString(),
  };
}

/**
 * BigBrother: ต่อยอดจาก LittleBrother ถ้า content น่าสงสัยและมี GEMINI_API_KEY
 * จะยิงไปถาม Gemini เพื่อวิเคราะห์เชิงบริบทเพิ่ม (เช่น สังคมวิศวกรรม/มุกหลอกที่ regex จับไม่ได้)
 */
async function bigBrotherScan(content, fetchImpl = global.fetch) {
  const base = littleBrotherScan(content);

  if (base.verdict === "safe") {
    return { ...base, engine: "BigBrother", aiReview: null };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      ...base,
      engine: "BigBrother",
      aiReview: { skipped: true, reason: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน .env" },
    };
  }

  try {
    const resp = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text:
                    "คุณคือระบบตรวจจับข้อความหลอกลวง/ฟิชชิ่งสำหรับแพลตฟอร์มโซเชียลของวัยรุ่น " +
                    "วิเคราะห์ข้อความต่อไปนี้ว่ามีความเสี่ยงเป็นการหลอกลวง (phishing/scam) หรือไม่ " +
                    "ตอบเป็น JSON เท่านั้น รูปแบบ {\"risk\":\"low|medium|high\",\"reason\":\"อธิบายสั้นๆ ภาษาไทย\"}\n\n" +
                    "ข้อความ: " +
                    content,
                },
              ],
            },
          ],
        }),
      }
    );
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { risk: "unknown", reason: "แยกผลลัพธ์จาก AI ไม่สำเร็จ" };
    }
    return { ...base, engine: "BigBrother", aiReview: parsed };
  } catch (err) {
    return {
      ...base,
      engine: "BigBrother",
      aiReview: { error: true, message: "เรียก Gemini API ไม่สำเร็จ: " + err.message },
    };
  }
}

/** เก็บสถิติรายวันแบบง่ายๆ ไว้โชว์บน Dashboard (โปรดักชันจริงควรย้ายไป DB) */
class GuardianStats {
  constructor() {
    this.day = new Date().toDateString();
    this.scanned = 0;
    this.blocked = 0;
    this.suspicious = 0;
    this.hitTypeCounts = { keyword: 0, url_pattern: 0, many_links: 0, grooming_pattern: 0 };
    this.recentLog = []; // เก็บ log ล่าสุดไว้โชว์บน dashboard (ไม่เก็บเนื้อหาเต็ม เก็บแค่สรุป)
    this.behaviorAnomalies = []; // สัญญาณผิดปกติจาก behaviorBaseline.js (advisory เท่านั้น ไม่ auto-punish)
  }

  _resetIfNewDay() {
    const today = new Date().toDateString();
    if (this.day !== today) {
      this.day = today;
      this.scanned = 0;
      this.blocked = 0;
      this.suspicious = 0;
      this.hitTypeCounts = { keyword: 0, url_pattern: 0, many_links: 0, grooming_pattern: 0 };
      this.recentLog = [];
      this.behaviorAnomalies = [];
    }
  }

  record(result) {
    this._resetIfNewDay();
    this.scanned += 1;
    if (result.verdict === "high_risk") this.blocked += 1;
    else if (result.verdict === "suspicious") this.suspicious += 1;

    for (const hit of result.hits || []) {
      if (this.hitTypeCounts[hit.type] !== undefined) this.hitTypeCounts[hit.type] += 1;
    }

    this.recentLog.unshift({
      verdict: result.verdict,
      score: result.score,
      hitCount: (result.hits || []).length,
      engine: result.engine,
      scannedAt: result.scannedAt || new Date().toISOString(),
    });
    if (this.recentLog.length > 50) this.recentLog.pop();
  }

  recordAnomaly(userId, anomaly) {
    this._resetIfNewDay();
    this.behaviorAnomalies.unshift({
      userId,
      type: anomaly.type,
      detail: anomaly.detail,
      at: new Date().toISOString(),
    });
    if (this.behaviorAnomalies.length > 50) this.behaviorAnomalies.pop();
  }

  summary() {
    this._resetIfNewDay();
    return {
      day: this.day,
      scanned: this.scanned,
      blocked: this.blocked,
      suspicious: this.suspicious,
      hitTypeCounts: this.hitTypeCounts,
      recentLog: this.recentLog.slice(0, 20),
      behaviorAnomalies: this.behaviorAnomalies.slice(0, 20),
    };
  }
}

module.exports = {
  littleBrotherScan,
  bigBrotherScan,
  checkAgainstSafeBrowsing,
  GuardianStats,
};
