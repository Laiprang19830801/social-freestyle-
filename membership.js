/**
 * membership.js
 * ระบบสมาชิก 3 ระดับ (Standard, Plus, Premium) + ระดับ VIP (Ultimate) แยกต่างหาก
 *
 * โครงสร้าง:
 *  - TIERS: นิยาม sitting ของแต่ละระดับ (สิทธิ์, limit ต่างๆ)
 *  - MembershipStore: เก็บสถานะสมาชิกแบบ in-memory (โปรดักชันจริงให้เปลี่ยนไปต่อ DB เช่น Postgres/Mongo)
 *  - can(): เช็คสิทธิ์แบบรวมศูนย์ ใช้ได้ทั้งฝั่ง API และฝั่ง UI (ส่งไปเป็น flags)
 */

const TIERS = {
  // ทั้ง 3 ระดับหลักโปรโมทตัวเองได้หมด ต่างกันที่โควต้าต่อวันและแรงบูสต์
  // ระดับ VIP Ultimate คือของแถมพิเศษสำหรับคนที่อยากได้โควต้าไม่จำกัด + บูสต์สูงสุด
  standard: {
    key: "standard",
    label: "Standard",
    price: 0,
    dailyPostLimit: 10,
    canSelfPromote: true,
    dailyPromoLimit: 1,
    aiBrotherLevel: "little", // ได้แค่ LittleBrother (สแกนพื้นฐาน)
    feedBoost: 1.1,
  },
  plus: {
    key: "plus",
    label: "Plus",
    price: 59,
    dailyPostLimit: 30,
    canSelfPromote: true,
    dailyPromoLimit: 3,
    aiBrotherLevel: "little",
    feedBoost: 1.3,
  },
  premium: {
    key: "premium",
    label: "Premium",
    price: 129,
    dailyPostLimit: 100,
    canSelfPromote: true,
    dailyPromoLimit: 8,
    aiBrotherLevel: "big", // ได้ BigBrother (สแกนละเอียด + รายงานรายวัน)
    feedBoost: 1.6,
  },
  ultimate: {
    key: "ultimate",
    label: "VIP Ultimate",
    price: 299,
    dailyPostLimit: -1, // ไม่จำกัด
    canSelfPromote: true,
    dailyPromoLimit: -1, // ไม่จำกัด
    aiBrotherLevel: "big",
    feedBoost: 2.0,
  },
};

class MembershipStore {
  constructor() {
    // userId -> { tier, promoCreditsToday, lastPromoReset }
    this.users = new Map();
  }

  ensureUser(userId) {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        tier: "standard",
        promoCreditsUsedToday: 0,
        postsToday: 0,
        lastReset: new Date().toDateString(),
      });
    }
    this._resetDailyIfNeeded(userId);
    return this.users.get(userId);
  }

  _resetDailyIfNeeded(userId) {
    const u = this.users.get(userId);
    const today = new Date().toDateString();
    if (u && u.lastReset !== today) {
      u.promoCreditsUsedToday = 0;
      u.postsToday = 0;
      u.lastReset = today;
    }
  }

  setTier(userId, tierKey) {
    if (!TIERS[tierKey]) throw new Error("ระดับสมาชิกไม่ถูกต้อง: " + tierKey);
    const u = this.ensureUser(userId);
    u.tier = tierKey;
    return u;
  }

  getTierConfig(userId) {
    const u = this.ensureUser(userId);
    return TIERS[u.tier];
  }

  /** เช็คว่าทำ action นี้ได้ไหม คืนค่า { allowed, reason } */
  can(userId, action) {
    const u = this.ensureUser(userId);
    const cfg = TIERS[u.tier];

    switch (action) {
      case "post": {
        if (cfg.dailyPostLimit === -1) return { allowed: true };
        if (u.postsToday >= cfg.dailyPostLimit) {
          return {
            allowed: false,
            reason: `โพสต์ครบโควต้ารายวันแล้ว (${cfg.dailyPostLimit} โพสต์/วัน) อัปเกรดแพ็กเกจเพื่อโพสต์เพิ่ม`,
          };
        }
        return { allowed: true };
      }
      case "selfPromote": {
        if (!cfg.canSelfPromote) {
          return { allowed: false, reason: "แพ็กเกจนี้โปรโมทตัวเองไม่ได้" };
        }
        if (cfg.dailyPromoLimit !== -1 && u.promoCreditsUsedToday >= cfg.dailyPromoLimit) {
          return {
            allowed: false,
            reason: `ใช้โควต้าโปรโมทวันนี้ครบแล้ว (${cfg.dailyPromoLimit} ครั้ง/วัน) อัปเกรดแพ็กเกจเพื่อโปรโมทได้มากขึ้น`,
          };
        }
        return { allowed: true };
      }
      case "aiBigBrother": {
        if (cfg.aiBrotherLevel !== "big") {
          return {
            allowed: false,
            reason: "รายงานสถิติ BigBrother แบบละเอียดมีเฉพาะแพ็กเกจ Premium ขึ้นไป",
          };
        }
        return { allowed: true };
      }
      default:
        return { allowed: false, reason: "ไม่รู้จัก action นี้" };
    }
  }

  recordPost(userId) {
    const u = this.ensureUser(userId);
    u.postsToday += 1;
    return u;
  }

  recordSelfPromote(userId) {
    const u = this.ensureUser(userId);
    u.promoCreditsUsedToday += 1;
    return u;
  }

  /** ส่ง object สรุปสิทธิ์ทั้งหมดของ user ไปให้ frontend ใช้ render UI */
  publicSummary(userId) {
    const u = this.ensureUser(userId);
    const cfg = TIERS[u.tier];
    return {
      tier: cfg.key,
      label: cfg.label,
      dailyPostLimit: cfg.dailyPostLimit,
      postsToday: u.postsToday,
      canSelfPromote: cfg.canSelfPromote,
      dailyPromoLimit: cfg.dailyPromoLimit,
      promoCreditsUsedToday: u.promoCreditsUsedToday,
      aiBrotherLevel: cfg.aiBrotherLevel,
      feedBoost: cfg.feedBoost,
    };
  }
}

module.exports = { TIERS, MembershipStore };
