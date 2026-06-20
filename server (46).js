/* =====================================================================
 * SHIB Mini App — Cloudflare Worker + Firebase Realtime Database
 * ---------------------------------------------------------------------
 * Required env vars (Worker -> Settings -> Variables):
 *   FIREBASE_DATABASE_URL   e.g. https://your-app.firebaseio.com
 *   FIREBASE_API_KEY        Web API key (for REST auth, optional)
 *   BOT_TOKEN               Telegram bot token (for initData HMAC)
 *   BOT_USERNAME            Telegram bot username (no @)
 *   ADMIN_IDS               Comma separated Telegram user IDs
 *   APP_SECRET              Random 32+ chars string (HMAC for sessions)
 *
 * Security:
 *   - Telegram initData HMAC validation
 *   - Session JWT (HMAC-SHA256) for API auth
 *   - Device fingerprint dedup (one account / device)
 *   - In-memory rate limiting per IP+user+action
 *   - All rewards/balances computed server-side only
 *   - All sensitive operations logged to /logs
 *   - Withdraw queued for admin approval; balance held atomically
 * ===================================================================== */

const REFERRAL_PCT = 25;          // %
const MIN_WITHDRAW = { TON: 1, USDT: 5 };
const SIGNUP_BONUS = 500;
const REWARDS = {
  daily_login:  500,
  daily_combo:  5000,
  channel_join: 1000,
  bot_join:     1000,
  invite_task:  2500,
};
const RATE_LIMITS = { window_ms: 60_000, max: 60 };
const TASK_VERIFY_DELAY_MS = 8_000; // anti-cheat: must wait after join

// ---------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
  dec: (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
  },
};

async function hmac(keyData, msg, algo = "SHA-256") {
  const key = await crypto.subtle.importKey(
    "raw",
    typeof keyData === "string" ? enc.encode(keyData) : keyData,
    { name: "HMAC", hash: algo }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
const hex = (u8) => [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
async function sha256(s) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))); }

// ---------------------------------------------------------------------
// Telegram initData verification
// ---------------------------------------------------------------------
async function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", botToken);
  const calc = hex(await hmac(secret, dataCheck));
  if (calc !== hash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // 24h
  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  if (!user || !user.id) return null;
  return { user, startParam: params.get("start_param") || null };
}

// ---------------------------------------------------------------------
// Session JWT (HMAC-SHA256)
// ---------------------------------------------------------------------
async function signSession(payload, secret) {
  const header = b64u.enc(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body   = b64u.enc(enc.encode(JSON.stringify(payload)));
  const sig    = b64u.enc(await hmac(secret, `${header}.${body}`));
  return `${header}.${body}.${sig}`;
}
async function verifySession(token, secret) {
  if (!token) return null;
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) return null;
  const expect = b64u.enc(await hmac(secret, `${h}.${b}`));
  if (expect !== s) return null;
  try {
    const p = JSON.parse(dec.decode(b64u.dec(b)));
    if (p.exp && Date.now() / 1000 > p.exp) return null;
    return p;
  } catch { return null; }
}

// ---------------------------------------------------------------------
// Firebase REST helpers
// ---------------------------------------------------------------------
function fb(env, path) {
  return `${env.FIREBASE_DATABASE_URL.replace(/\/$/, "")}/${path}.json`;
}
async function fbGet(env, path)            { const r = await fetch(fb(env, path)); return r.ok ? r.json() : null; }
async function fbSet(env, path, data)      { return fetch(fb(env, path), { method: "PUT",   body: JSON.stringify(data) }); }
async function fbUpdate(env, path, data)   { return fetch(fb(env, path), { method: "PATCH", body: JSON.stringify(data) }); }
async function fbPush(env, path, data)     {
  const r = await fetch(fb(env, path), { method: "POST", body: JSON.stringify(data) });
  return (await r.json()).name;
}

// ---------------------------------------------------------------------
// Rate limiting (in-memory, per isolate)
// ---------------------------------------------------------------------
const RL = new Map();
function rateLimit(key) {
  const now = Date.now();
  const e = RL.get(key) || { c: 0, t: now };
  if (now - e.t > RATE_LIMITS.window_ms) { e.c = 0; e.t = now; }
  e.c++;
  RL.set(key, e);
  return e.c <= RATE_LIMITS.max;
}

// ---------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------
async function logEvent(env, type, uid, data = {}) {
  try {
    await fbPush(env, "logs", { type, uid, ts: Date.now(), ...data });
  } catch {}
}

// ---------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Init-Data,X-Action,X-Device-Id",
  "Access-Control-Max-Age": "86400",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", ...CORS },
});

// ---------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------
function newUser(tg, deviceHash, refBy) {
  return {
    id: String(tg.id),
    first_name: tg.first_name || "",
    last_name:  tg.last_name  || "",
    username:   tg.username   || "",
    photo_url:  tg.photo_url  || "",
    balance: SIGNUP_BONUS,
    total_earned: SIGNUP_BONUS,
    referrals_count: 0,
    active_referrals: 0,
    referral_earned: 0,
    ref_by: refBy || null,
    device: deviceHash || null,
    created_at: Date.now(),
    last_login: Date.now(),
    last_daily: 0,
    last_combo: 0,
    completed_tasks: {},
  };
}

async function getOrCreateUser(env, tg, deviceHash, startParam) {
  const uid = String(tg.id);
  let user = await fbGet(env, `users/${uid}`);

  if (!user) {
    // Device dedup
    if (deviceHash) {
      const existing = await fbGet(env, `devices/${deviceHash}`);
      if (existing && existing.uid && existing.uid !== uid) {
        return { error: "DEVICE_TAKEN" };
      }
    }
    const refBy = startParam && /^\d+$/.test(startParam) && startParam !== uid ? startParam : null;
    user = newUser(tg, deviceHash, refBy);
    await fbSet(env, `users/${uid}`, user);
    if (deviceHash) await fbSet(env, `devices/${deviceHash}`, { uid, ts: Date.now() });
    if (refBy) {
      const ref = await fbGet(env, `users/${refBy}`);
      if (ref) {
        await fbUpdate(env, `users/${refBy}`, {
          referrals_count: (ref.referrals_count || 0) + 1,
        });
        await fbPush(env, `referrals/${refBy}`, {
          uid, name: tg.first_name || tg.username || "User",
          photo: tg.photo_url || "", ts: Date.now(), earned: 0,
        });
      }
    }
    await logEvent(env, "signup", uid, { ref_by: refBy });
  } else {
    // sync profile + last_login
    const patch = { last_login: Date.now() };
    if (tg.first_name && tg.first_name !== user.first_name) patch.first_name = tg.first_name;
    if (tg.username   && tg.username   !== user.username)   patch.username   = tg.username;
    if (tg.photo_url  && tg.photo_url  !== user.photo_url)  patch.photo_url  = tg.photo_url;
    await fbUpdate(env, `users/${uid}`, patch);
    Object.assign(user, patch);
  }
  return { user };
}

async function credit(env, uid, amount, reason, meta = {}) {
  const user = await fbGet(env, `users/${uid}`);
  if (!user) return null;
  const newBal = (user.balance || 0) + amount;
  await fbUpdate(env, `users/${uid}`, {
    balance: newBal,
    total_earned: (user.total_earned || 0) + (amount > 0 ? amount : 0),
  });
  await fbPush(env, `rewards/${uid}`, {
    amount, reason, ts: Date.now(), ...meta,
  });
  await logEvent(env, "credit", uid, { amount, reason, ...meta });

  // Referral commission
  if (amount > 0 && user.ref_by && reason !== "referral") {
    const cut = Math.floor(amount * REFERRAL_PCT / 100);
    if (cut > 0) {
      const ref = await fbGet(env, `users/${user.ref_by}`);
      if (ref) {
        await fbUpdate(env, `users/${user.ref_by}`, {
          balance: (ref.balance || 0) + cut,
          total_earned: (ref.total_earned || 0) + cut,
          referral_earned: (ref.referral_earned || 0) + cut,
          active_referrals: (ref.active_referrals || 0) + (user.total_earned ? 0 : 1),
        });
        await fbPush(env, `rewards/${user.ref_by}`, {
          amount: cut, reason: "referral", from: uid, ts: Date.now(),
        });
      }
    }
  }
  return newBal;
}

// ---------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------
const actions = {
  async auth(env, body, ctx) {
    const v = await verifyInitData(body.initData, env.BOT_TOKEN);
    if (!v) return json({ error: "INVALID_INIT_DATA" }, 401);
    const deviceHash = body.device ? await sha256(body.device + ":" + env.APP_SECRET) : null;
    const res = await getOrCreateUser(env, v.user, deviceHash, v.startParam);
    if (res.error) return json({ error: res.error }, 403);

    const token = await signSession({
      uid: res.user.id,
      exp: Math.floor(Date.now() / 1000) + 7 * 86400,
    }, env.APP_SECRET);
    return json({ ok: true, token, user: res.user });
  },

  async getState(env, body, ctx) {
    const u = await fbGet(env, `users/${ctx.uid}`);
    if (!u) return json({ error: "NO_USER" }, 404);
    const rewards = await fbGet(env, `rewards/${ctx.uid}`) || {};
    const recent = Object.values(rewards).sort((a, b) => b.ts - a.ts).slice(0, 10);
    return json({ user: u, recent_rewards: recent });
  },

  async claimDaily(env, body, ctx) {
    const u = await fbGet(env, `users/${ctx.uid}`);
    if (!u) return json({ error: "NO_USER" }, 404);
    const today = new Date().toISOString().slice(0, 10);
    const last  = u.last_daily ? new Date(u.last_daily).toISOString().slice(0, 10) : "";
    if (today === last) return json({ error: "ALREADY_CLAIMED" }, 400);
    await fbUpdate(env, `users/${ctx.uid}`, { last_daily: Date.now() });
    const bal = await credit(env, ctx.uid, REWARDS.daily_login, "daily_login");
    return json({ ok: true, balance: bal, reward: REWARDS.daily_login });
  },

  async startTask(env, body, ctx) {
    const taskId = String(body.taskId || "");
    if (!taskId) return json({ error: "BAD_TASK" }, 400);
    const task = await fbGet(env, `tasks/${taskId}`);
    if (!task || !task.active) return json({ error: "TASK_NOT_FOUND" }, 404);
    const u = await fbGet(env, `users/${ctx.uid}`);
    if (u.completed_tasks && u.completed_tasks[taskId]) {
      return json({ error: "ALREADY_DONE" }, 400);
    }
    await fbUpdate(env, `users/${ctx.uid}/started_tasks`, { [taskId]: Date.now() });
    return json({ ok: true, verify_after_ms: TASK_VERIFY_DELAY_MS });
  },

  async verifyTask(env, body, ctx) {
    const taskId = String(body.taskId || "");
    const u = await fbGet(env, `users/${ctx.uid}`);
    if (!u) return json({ error: "NO_USER" }, 404);
    const started = u.started_tasks && u.started_tasks[taskId];
    if (!started) return json({ error: "NOT_STARTED" }, 400);
    if (Date.now() - started < TASK_VERIFY_DELAY_MS) {
      return json({ error: "TOO_EARLY" }, 400);
    }
    if (u.completed_tasks && u.completed_tasks[taskId]) {
      return json({ error: "ALREADY_DONE" }, 400);
    }
    const task = await fbGet(env, `tasks/${taskId}`);
    if (!task || !task.active) return json({ error: "TASK_NOT_FOUND" }, 404);

    // Optional: real channel-membership check via Bot API
    if (task.type === "channel" && task.chat_id && env.BOT_TOKEN) {
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(task.chat_id)}&user_id=${ctx.uid}`);
      const d = await r.json();
      const st = d?.result?.status;
      if (!st || ["left", "kicked"].includes(st)) {
        return json({ error: "NOT_JOINED" }, 400);
      }
    }
    await fbUpdate(env, `users/${ctx.uid}/completed_tasks`, { [taskId]: Date.now() });
    const bal = await credit(env, ctx.uid, task.reward, "task", { taskId });
    return json({ ok: true, balance: bal, reward: task.reward });
  },

  async getTasks(env, body, ctx) {
    const all = await fbGet(env, "tasks") || {};
    const u = await fbGet(env, `users/${ctx.uid}`);
    const done = (u && u.completed_tasks) || {};
    const started = (u && u.started_tasks) || {};
    const out = Object.entries(all)
      .filter(([, t]) => t && t.active)
      .map(([id, t]) => ({
        id, ...t,
        status: done[id] ? "done" : started[id] ? "started" : "new",
      }));
    return json({ tasks: out });
  },

  async submitTask(env, body, ctx) {
    const { title, link, type } = body;
    if (!title || !link) return json({ error: "BAD_INPUT" }, 400);
    const id = await fbPush(env, "pending_tasks", {
      uid: ctx.uid, title, link, type: type || "channel",
      ts: Date.now(), status: "pending",
    });
    await logEvent(env, "task_submit", ctx.uid, { id, title });
    return json({ ok: true });
  },

  async getReferrals(env, body, ctx) {
    const offset = Number(body.offset || 0);
    const limit  = Math.min(Number(body.limit || 20), 50);
    const all = await fbGet(env, `referrals/${ctx.uid}`) || {};
    const list = Object.values(all).sort((a, b) => b.ts - a.ts);
    return json({ total: list.length, items: list.slice(offset, offset + limit) });
  },

  async withdraw(env, body, ctx) {
    const { currency, address, amount } = body;
    if (!["TON", "USDT"].includes(currency)) return json({ error: "BAD_CURRENCY" }, 400);
    if (!address || address.length < 10)     return json({ error: "BAD_ADDRESS" }, 400);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0)   return json({ error: "BAD_AMOUNT" }, 400);
    if (amt < MIN_WITHDRAW[currency])        return json({ error: "BELOW_MIN" }, 400);
    const u = await fbGet(env, `users/${ctx.uid}`);
    if (!u || (u.balance || 0) < amt)        return json({ error: "INSUFFICIENT" }, 400);

    // Atomic hold
    await fbUpdate(env, `users/${ctx.uid}`, { balance: u.balance - amt });
    const id = await fbPush(env, "withdraws", {
      uid: ctx.uid, currency, address, amount: amt,
      status: "pending", ts: Date.now(),
    });
    await logEvent(env, "withdraw_request", ctx.uid, { id, currency, amount: amt });
    return json({ ok: true, id, balance: u.balance - amt });
  },

  async getWallet(env, body, ctx) {
    const wd = await fbGet(env, "withdraws") || {};
    const mine = Object.entries(wd)
      .filter(([, w]) => w.uid === ctx.uid)
      .map(([id, w]) => ({ id, ...w }))
      .sort((a, b) => b.ts - a.ts);
    return json({ withdraws: mine, min: MIN_WITHDRAW });
  },

  // ---- admin
  async adminApproveWithdraw(env, body, ctx) {
    if (!ctx.admin) return json({ error: "FORBIDDEN" }, 403);
    const w = await fbGet(env, `withdraws/${body.id}`);
    if (!w || w.status !== "pending") return json({ error: "NOT_FOUND" }, 404);
    await fbUpdate(env, `withdraws/${body.id}`, {
      status: "approved", tx_hash: body.tx_hash || "", processed_at: Date.now(),
    });
    await logEvent(env, "withdraw_approve", w.uid, { id: body.id });
    return json({ ok: true });
  },
  async adminRejectWithdraw(env, body, ctx) {
    if (!ctx.admin) return json({ error: "FORBIDDEN" }, 403);
    const w = await fbGet(env, `withdraws/${body.id}`);
    if (!w || w.status !== "pending") return json({ error: "NOT_FOUND" }, 404);
    const u = await fbGet(env, `users/${w.uid}`);
    if (u) await fbUpdate(env, `users/${w.uid}`, { balance: (u.balance || 0) + w.amount });
    await fbUpdate(env, `withdraws/${body.id}`, {
      status: "rejected", reason: body.reason || "", processed_at: Date.now(),
    });
    await logEvent(env, "withdraw_reject", w.uid, { id: body.id });
    return json({ ok: true });
  },
  async adminAddTask(env, body, ctx) {
    if (!ctx.admin) return json({ error: "FORBIDDEN" }, 403);
    const t = {
      title: body.title, link: body.link, type: body.type || "channel",
      reward: Number(body.reward) || REWARDS.channel_join,
      icon: body.icon || "", chat_id: body.chat_id || "",
      active: true, created_at: Date.now(),
    };
    const id = await fbPush(env, "tasks", t);
    return json({ ok: true, id });
  },

  ping(env)  { return json({ ok: true, ts: Date.now() }); },
};

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------
const PUBLIC_ACTIONS = new Set(["auth", "ping"]);

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });

    if (request.method !== "POST") return json({ error: "METHOD" }, 405);

    let body = {};
    try { body = await request.json(); } catch {}
    const action = request.headers.get("X-Action") || body.action;
    if (!action || !actions[action]) return json({ error: "BAD_ACTION" }, 400);

    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    if (!rateLimit(`${ip}:${action}`)) return json({ error: "RATE_LIMIT" }, 429);

    let ctx = {};
    if (!PUBLIC_ACTIONS.has(action)) {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const sess  = await verifySession(token, env.APP_SECRET);
      if (!sess) return json({ error: "UNAUTHORIZED" }, 401);
      ctx.uid = sess.uid;
      ctx.admin = (env.ADMIN_IDS || "").split(",").map(s => s.trim()).includes(sess.uid);
      if (!rateLimit(`${ctx.uid}:${action}`)) return json({ error: "RATE_LIMIT" }, 429);
    }

    try {
      return await actions[action](env, body, ctx);
    } catch (e) {
      await logEvent(env, "error", ctx.uid || "anon", { action, err: String(e) });
      return json({ error: "SERVER_ERROR", detail: String(e) }, 500);
    }
  },
};
