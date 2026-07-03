/**
 * liveShop.js
 * โซนไลฟ์ขายของ — วัยรุ่นเปิดไลฟ์คุย/ขายของกันเอง เราแค่คุมความปลอดภัยของ "แชท" ให้
 * (เนื้อหาการซื้อขาย/การตกลงกันเอง ไม่ใช่หน้าที่เราไปยุ่ง — สแกนแค่ภัยคุกคามผ่าน aiGuardian)
 *
 * หมายเหตุสำคัญ: โมดูลนี้จัดการ "แชทไลฟ์" + "ห้องไลฟ์" + "สินค้าที่ปักหมุด" เท่านั้น
 * มันไม่ได้ทำการ encode/stream วิดีโอจริง (นั่นต้องใช้บริการ RTMP/WebRTC เช่น Agora, LiveKit, Mux)
 * ช่อง <video> ฝั่ง frontend เป็นจุดที่ต้องเสียบ embed/SDK ของผู้ให้บริการสตรีมจริงเข้ามาเอง
 */

class LiveShopStore {
  constructor() {
    this.sessions = new Map(); // sessionId -> session object
  }

  createSession(userId, title) {
    const id = "live_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const session = {
      id,
      hostUserId: userId,
      title: title || "ไลฟ์ขายของ",
      startedAt: new Date().toISOString(),
      endedAt: null,
      viewers: new Set(),
      products: [], // { id, name, price, link }
      chatLog: [], // เก็บย้อนหลังสั้นๆ ไว้โชว์ตอนเข้าห้อง (ไม่ persist ยาว)
    };
    this.sessions.set(id, session);
    return session;
  }

  endSession(id, userId) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: "ไม่พบห้องไลฟ์นี้" };
    if (s.hostUserId !== userId) return { ok: false, error: "เฉพาะเจ้าของไลฟ์เท่านั้นที่ปิดห้องได้" };
    s.endedAt = new Date().toISOString();
    return { ok: true };
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  listActive() {
    return [...this.sessions.values()]
      .filter((s) => !s.endedAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        hostUserId: s.hostUserId,
        startedAt: s.startedAt,
        viewerCount: s.viewers.size,
        products: s.products,
      }));
  }

  addProduct(id, product) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const item = {
      id: "p_" + Date.now().toString(36),
      name: String(product.name || "").slice(0, 120),
      price: Number(product.price) || 0,
      link: String(product.link || "").slice(0, 500),
    };
    s.products.push(item);
    return item;
  }

  addChatMessage(id, message) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.chatLog.push(message);
    // เก็บแค่ 200 ข้อความล่าสุดพอ กัน memory บวม
    if (s.chatLog.length > 200) s.chatLog.shift();
  }
}

module.exports = { LiveShopStore };
