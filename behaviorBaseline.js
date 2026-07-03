/**
 * behaviorBaseline.js
 * ติดตามพฤติกรรม "ปกติ" ของแต่ละคนเอง แล้วเทียบหาความเบี้ยงเบนผิดปกติ
 * (พี่แชมป์เป็นคนเสนอแนวคิดนี้: ไล่ตามพฤติกรรม ไม่ใช่ไล่สแกนหาไวรัสอย่างเดียว)
 *
 * หลักการสำคัญ: โมดูลนี้ทำหน้าที่แค่ "ยกมือขึ้นเตือน" (flag) เท่านั้น
 * ไม่มีสิทธิ์มิวท์ ระงับ หรือลงโทษใครโดยอัตโนมัติเด็ดขาด — ทุกอย่างที่นี่ถูกออกแบบให้
 * ไปโผล่ในหน้ารายงานให้ "คน" เป็นคนตัดสินใจต่อเท่านั้น ตรงตามหลักที่ว่า
 * "ระบบความปลอดภัยอาศัยระบบอัตโนมัติล้วนๆ ไม่ได้"
 */

const SHORT_WINDOW_MS = 5 * 60 * 1000; // 5 นาที ไว้ดู burst
const LONG_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 ชั่วโมง ไว้คำนวณ baseline ปกติ
const BURST_ABSOLUTE_THRESHOLD = 8; // 8 ข้อความใน 5 นาที ถือว่าผิดปกติแน่ๆ ไม่ว่า baseline จะเป็นเท่าไหร่
const BURST_RATIO_THRESHOLD = 4; // อัตราปัจจุบันสูงกว่า baseline ปกติ 4 เท่า = ผิดปกติ
const MIN_EVENTS_FOR_BASELINE = 10; // ต้องมีข้อมูลอย่างน้อยเท่านี้ก่อนจะเชื่อ baseline ได้

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

class BehaviorBaseline {
  constructor() {
    this.users = new Map(); // userId -> { events: [{at, domains: []}], knownDomains: Set }
  }

  _ensure(userId) {
    if (!this.users.has(userId)) {
      this.users.set(userId, { events: [], knownDomains: new Set() });
    }
    return this.users.get(userId);
  }

  _pruneOld(rec, now) {
    rec.events = rec.events.filter((e) => now - e.at <= LONG_WINDOW_MS);
  }

  /**
   * เรียกทุกครั้งที่มีการโพสต์/แชท คืนค่ารายการ "สัญญาณผิดปกติ" ที่พบ (อาจว่างเปล่า)
   * text ใช้แค่ดึงลิงก์ออกมาดูโดเมน ไม่ได้เก็บเนื้อหาข้อความไว้
   */
  recordAndCheck(userId, text) {
    const now = Date.now();
    const rec = this._ensure(userId);
    this._pruneOld(rec, now);

    const urls = (text.match(/https?:\/\/[^\s]+/g) || []);
    const domains = urls.map(extractDomain).filter(Boolean);

    const anomalies = [];

    // --- เช็ค burst: โพสต์ถี่ผิดปกติ ---
    const recentCount = rec.events.filter((e) => now - e.at <= SHORT_WINDOW_MS).length + 1;
    if (recentCount >= BURST_ABSOLUTE_THRESHOLD) {
      anomalies.push({
        type: "burst_activity",
        detail: `โพสต์/แชท ${recentCount} ครั้ง ภายใน 5 นาที`,
      });
    } else if (rec.events.length >= MIN_EVENTS_FOR_BASELINE) {
      const hours = LONG_WINDOW_MS / (60 * 60 * 1000);
      const baselineRatePerMin = rec.events.length / (hours * 60);
      const recentRatePerMin = recentCount / (SHORT_WINDOW_MS / 60000);
      if (baselineRatePerMin > 0 && recentRatePerMin > baselineRatePerMin * BURST_RATIO_THRESHOLD) {
        anomalies.push({
          type: "rate_spike",
          detail: `อัตราการโพสต์พุ่งขึ้น ~${Math.round(recentRatePerMin / baselineRatePerMin)} เท่าจากปกติ`,
        });
      }
    }

    // --- เช็คโดเมนใหม่ที่ไม่เคยเจอ หลังจากมี pattern การใช้โดเมนเดิมมาก่อนแล้ว ---
    if (domains.length > 0 && rec.knownDomains.size >= 2) {
      const newDomains = domains.filter((d) => !rec.knownDomains.has(d));
      if (newDomains.length > 0) {
        anomalies.push({
          type: "new_domain_pattern",
          detail: `เริ่มแชร์ลิงก์จากโดเมนใหม่ที่ไม่เคยใช้มาก่อน: ${newDomains.join(", ")}`,
        });
      }
    }

    // บันทึก event หลังเช็คเสร็จ (ไม่รวมกับที่กำลังเช็คอยู่ เพื่อไม่ให้นับตัวเองซ้ำ)
    rec.events.push({ at: now, domains });
    domains.forEach((d) => rec.knownDomains.add(d));

    return anomalies;
  }
}

module.exports = { BehaviorBaseline };
