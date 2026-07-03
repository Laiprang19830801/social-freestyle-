// app.js — LaiprangBrain & GeminiSearch frontend logic

const state = {
  membership: null,
  tiers: [],
};

/* ===================== View switching ===================== */

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("view-" + btn.dataset.view).classList.add("active");

    if (btn.dataset.view === "guardian") loadGuardianStats();
    if (btn.dataset.view === "membership") renderTierGrid();
    if (btn.dataset.view === "live") loadLiveList();
  });
});

/* ===================== Bootstrap ===================== */

async function loadMe() {
  const res = await fetch("/api/me");
  const data = await res.json();
  state.membership = data.membership;
  state.tiers = data.tiers;
  document.getElementById("tierBadge").textContent = data.membership.label;
  renderTierGrid();
}

async function loadPlatformStatus() {
  const res = await fetch("/api/proxy/status");
  const data = await res.json();
  const el = document.getElementById("platformStatus");
  const lines = Object.entries(data).map(
    ([platform, connected]) => `${platform}: ${connected ? "เชื่อมต่อแล้ว" : "ยังไม่ได้ตั้งค่า API key"}`
  );
  el.textContent = lines.join("  |  ");
}

/* ===================== Post ===================== */

document.getElementById("submitPost").addEventListener("click", async () => {
  const text = document.getElementById("postText").value.trim();
  const resultEl = document.getElementById("postResult");
  if (!text) {
    resultEl.textContent = "พิมพ์อะไรสักหน่อยก่อนโพสต์";
    resultEl.className = "result-box error";
    return;
  }

  resultEl.textContent = "กำลังส่งผ่าน AI พี่น้อง...";
  resultEl.className = "result-box";

  try {
    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (data.ok) {
      resultEl.textContent = `โพสต์สำเร็จ ✅ (ผลสแกน: ${data.scan.verdict})`;
      resultEl.className = "result-box ok";
      document.getElementById("postText").value = "";
      loadMe();
    } else {
      resultEl.textContent = "❌ " + data.error;
      resultEl.className = "result-box error";
    }
  } catch (err) {
    resultEl.textContent = "❌ ส่งโพสต์ไม่สำเร็จ: " + err.message;
    resultEl.className = "result-box error";
  }
});

document.getElementById("selfPromoteBtn").addEventListener("click", async () => {
  const resultEl = document.getElementById("postResult");
  try {
    const res = await fetch("/api/posts/self-promote", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      resultEl.textContent = `🚀 ${data.message} (feed boost x${data.feedBoost})`;
      resultEl.className = "result-box ok";
    } else {
      resultEl.textContent = "❌ " + data.error;
      resultEl.className = "result-box error";
    }
  } catch (err) {
    resultEl.textContent = "❌ " + err.message;
    resultEl.className = "result-box error";
  }
});

/* ===================== Guardian ===================== */

async function loadGuardianStats() {
  const res = await fetch("/api/guardian/stats");
  const data = await res.json();
  document.getElementById("statScanned").textContent = data.stats.scanned;
  document.getElementById("statBlocked").textContent = data.stats.blocked;
  document.getElementById("statSuspicious").textContent = data.stats.suspicious;
  renderHitBreakdown(data.stats.hitTypeCounts);
  renderReportTable(data.stats.recentLog);

  const flaggedRes = await fetch("/api/guardian/flagged");
  const flaggedData = await flaggedRes.json();
  renderFlaggedTable(flaggedData.flagged);
  renderAnomalyTable(data.stats.behaviorAnomalies);
}

function renderAnomalyTable(anomalies) {
  const el = document.getElementById("anomalyTable");
  if (!anomalies || !anomalies.length) {
    el.innerHTML = `<div class="report-empty">ยังไม่มีสัญญาณพฤติกรรมผิดปกติวันนี้</div>`;
    return;
  }
  const rows = anomalies
    .map((a) => {
      const time = new Date(a.at).toLocaleTimeString("th-TH");
      return `
        <div class="report-row">
          <span>${time}</span>
          <span>${escapeHtml(a.userId)}</span>
          <span class="v-suspicious">${a.type}</span>
          <span>${escapeHtml(a.detail)}</span>
        </div>`;
    })
    .join("");
  el.innerHTML = `
    <div class="report-row header">
      <span>เวลา</span><span>ผู้ใช้</span><span>ประเภท</span><span>รายละเอียด</span>
    </div>
    ${rows}`;
}

function renderFlaggedTable(flagged) {
  const el = document.getElementById("flaggedTable");
  if (!flagged || !flagged.length) {
    el.innerHTML = `<div class="report-empty">ไม่มีใครถูกส่งตรวจสอบวันนี้ ✅</div>`;
    return;
  }
  const rows = flagged
    .map(
      (f) => `
        <div class="report-row">
          <span>${escapeHtml(f.userId)}</span>
          <span>ทำผิด ${f.violationCount} ครั้ง</span>
          <span class="v-high_risk">ต้องตรวจสอบ</span>
        </div>`
    )
    .join("");
  el.innerHTML = `
    <div class="report-row header">
      <span>ผู้ใช้</span><span>จำนวนครั้ง</span><span>สถานะ</span>
    </div>
    ${rows}`;
}

const HIT_TYPE_LABELS = {
  keyword: "คำต้องสงสัย",
  url_pattern: "ลิงก์เสี่ยง",
  many_links: "ลิงก์เยอะผิดปกติ",
};

function renderHitBreakdown(counts) {
  const el = document.getElementById("hitBreakdown");
  if (!counts) return;
  const max = Math.max(1, ...Object.values(counts));
  el.innerHTML = Object.entries(counts)
    .map(([type, count]) => {
      const pct = Math.round((count / max) * 100);
      return `
        <div class="hit-row">
          <span>${HIT_TYPE_LABELS[type] || type}</span>
          <span class="hit-bar-track"><span class="hit-bar-fill" style="width:${pct}%"></span></span>
          <span>${count}</span>
        </div>`;
    })
    .join("");
}

function renderReportTable(log) {
  const el = document.getElementById("reportTable");
  if (!log || !log.length) {
    el.innerHTML = `<div class="report-empty">ยังไม่มีประวัติการสแกนวันนี้</div>`;
    return;
  }
  const rows = log
    .map((r) => {
      const time = new Date(r.scannedAt).toLocaleTimeString("th-TH");
      return `
        <div class="report-row">
          <span>${time}</span>
          <span>${r.engine}</span>
          <span>${r.score}</span>
          <span class="v-${r.verdict}">${r.verdict}</span>
          <span>${r.hitCount} จุดที่เจอ</span>
        </div>`;
    })
    .join("");
  el.innerHTML = `
    <div class="report-row header">
      <span>เวลา</span><span>เอนจิน</span><span>คะแนน</span><span>ผลลัพธ์</span><span>รายละเอียด</span>
    </div>
    ${rows}`;
}

document.getElementById("scanBtn").addEventListener("click", async () => {
  const content = document.getElementById("scanText").value.trim();
  const resultEl = document.getElementById("scanResult");
  if (!content) return;

  resultEl.textContent = "กำลังสแกน...";
  resultEl.className = "result-box";

  try {
    const res = await fetch("/api/guardian/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    resultEl.textContent = JSON.stringify(data.result, null, 2);
    resultEl.className =
      data.result.verdict === "high_risk" ? "result-box error" : "result-box ok";
    loadGuardianStats();
  } catch (err) {
    resultEl.textContent = "❌ " + err.message;
    resultEl.className = "result-box error";
  }
});

/* ===================== Membership ===================== */

function renderTierGrid() {
  if (!state.tiers.length) return;
  const grid = document.getElementById("tierGrid");
  grid.innerHTML = "";

  state.tiers.forEach((tier) => {
    const card = document.createElement("div");
    card.className = "tier-card" + (state.membership.tier === tier.key ? " current" : "");
    card.innerHTML = `
      <span class="tier-name">${tier.label}</span>
      <span class="tier-price">${tier.price === 0 ? "ฟรี" : "฿" + tier.price + "/เดือน"}</span>
      <span class="tier-feature">โพสต์/วัน: ${tier.dailyPostLimit === -1 ? "ไม่จำกัด" : tier.dailyPostLimit}</span>
      <span class="tier-feature">โปรโมทตัวเอง: ${tier.canSelfPromote ? "✅" : "❌"}</span>
      <button class="btn btn-primary" data-tier="${tier.key}">
        ${state.membership.tier === tier.key ? "ใช้อยู่" : "อัปเกรด"}
      </button>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll("button[data-tier]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch("/api/membership/upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: btn.dataset.tier }),
      });
      loadMe();
    });
  });
}

/* ===================== Live Shop ===================== */

let currentLiveSocket = null;
let currentLiveSessionId = null;
let currentLiveIsHost = false;

async function loadLiveList() {
  const res = await fetch("/api/live/sessions");
  const data = await res.json();
  const el = document.getElementById("liveList");

  if (!data.sessions.length) {
    el.innerHTML = `<div class="report-empty">ยังไม่มีใครเปิดไลฟ์อยู่ตอนนี้</div>`;
    return;
  }

  el.innerHTML = data.sessions
    .map(
      (s) => `
      <div class="live-card" data-session="${s.id}">
        <span class="live-title"><span class="live-dot"></span>${escapeHtml(s.title)}</span>
        <span class="live-meta">${s.viewerCount} คนกำลังดู · เริ่ม ${new Date(s.startedAt).toLocaleTimeString("th-TH")}</span>
      </div>`
    )
    .join("");

  el.querySelectorAll(".live-card").forEach((card) => {
    card.addEventListener("click", () => joinLive(card.dataset.session, false));
  });
}

document.getElementById("startLiveBtn").addEventListener("click", async () => {
  const title = document.getElementById("liveTitle").value.trim() || "ไลฟ์ขายของ";
  const res = await fetch("/api/live/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const data = await res.json();
  if (data.ok) {
    document.getElementById("liveTitle").value = "";
    loadLiveList();
    joinLive(data.session.id, true);
  }
});

function joinLive(sessionId, isHost) {
  if (currentLiveSocket) currentLiveSocket.close();

  currentLiveSessionId = sessionId;
  currentLiveIsHost = isHost;

  document.getElementById("liveRoom").classList.remove("hidden");
  document.getElementById("liveAddProductBox").classList.toggle("hidden", !isHost);
  document.getElementById("liveChatLog").innerHTML = "";
  document.getElementById("liveProducts").innerHTML = "";

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  currentLiveSocket = new WebSocket(`${protocol}//${location.host}/ws/live/${sessionId}`);

  currentLiveSocket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "chat") appendChatLine(data);
    if (data.type === "blocked" || data.type === "error") appendSystemLine(data.error);
    if (data.type === "viewer_count") {
      // อัปเดตจำนวนคนดูแบบ real-time (โชว์ในหัวห้องถ้าต้องการ ตอนนี้ log ไว้เฉยๆ)
    }
  });

  currentLiveSocket.addEventListener("close", () => {
    appendSystemLine("การเชื่อมต่อไลฟ์สิ้นสุดลง");
  });
}

function appendChatLine(msg) {
  const log = document.getElementById("liveChatLog");
  const line = document.createElement("div");
  line.className = "chat-line" + (msg.verdict === "suspicious" ? " suspicious" : "");
  line.innerHTML = `<span class="chat-user">${escapeHtml(msg.userId)}:</span>${escapeHtml(msg.text)}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function appendSystemLine(text) {
  const log = document.getElementById("liveChatLog");
  const line = document.createElement("div");
  line.className = "chat-line system";
  line.textContent = "⚠ " + text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

document.getElementById("sendChatBtn").addEventListener("click", sendLiveChat);
document.getElementById("liveChatText").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendLiveChat();
});

function sendLiveChat() {
  const input = document.getElementById("liveChatText");
  const text = input.value.trim();
  if (!text || !currentLiveSocket || currentLiveSocket.readyState !== 1) return;
  currentLiveSocket.send(
    JSON.stringify({ type: "chat", text, userId: state.membership?.tier ? "คุณ" : "guest" })
  );
  input.value = "";
}

document.getElementById("addProductBtn").addEventListener("click", async () => {
  if (!currentLiveSessionId || !currentLiveIsHost) return;
  const name = document.getElementById("prodName").value.trim();
  const price = document.getElementById("prodPrice").value;
  const link = document.getElementById("prodLink").value.trim();
  if (!name) return;

  const res = await fetch(`/api/live/sessions/${currentLiveSessionId}/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, price, link }),
  });
  const data = await res.json();
  if (data.ok) {
    const el = document.getElementById("liveProducts");
    const pin = document.createElement("div");
    pin.className = "product-pin";
    pin.innerHTML = `<span>📌 ${escapeHtml(data.product.name)} — ฿${data.product.price}</span>`;
    el.appendChild(pin);
    document.getElementById("prodName").value = "";
    document.getElementById("prodPrice").value = "";
    document.getElementById("prodLink").value = "";
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/* ===================== Init ===================== */

loadMe();
loadPlatformStatus();
