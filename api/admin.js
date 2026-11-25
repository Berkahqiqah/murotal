// api/admin.js - Vercel Serverless Function (Node 18+)
// Hanya bisa dipakai oleh akun admin (email = ADMIN_EMAIL). Kunci rahasia TIDAK pernah dikirim ke browser.
const SB_URL = (process.env.SUPABASE_URL || "https://amktgzdvkuiachxwrcsi.supabase.co").replace(/\/$/, "");
const ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_dzsT6aE7JIY3-C9nR71Ldw_sbhjhnMD";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ADMIN = (process.env.ADMIN_EMAIL || "aditya.rizal.752@gmail.com").toLowerCase();
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 2);
const QUOTA = Number(process.env.PROMO_QUOTA || 10);
const DAY = 864e5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sh = (extra) => {
  const h = Object.assign({ apikey: SERVICE, "Content-Type": "application/json" }, extra || {});
  if (SERVICE.startsWith("eyJ")) h.Authorization = "Bearer " + SERVICE; // kunci lama (JWT); kunci sb_secret_ cukup lewat apikey
  return h;
};

async function who(req) {
  const a = req.headers.authorization || "";
  const t = a.startsWith("Bearer ") ? a.slice(7) : "";
  if (!t) return null;
  const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + t } });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !u.email || !u.email_confirmed_at) return null;
  return u.email.toLowerCase() === ADMIN ? u : null;
}

function planOf(u) {
  const am = u.app_metadata || {};
  if (am.plan === "pro") {
    const until = am.pro_until ? new Date(am.pro_until).getTime() : null;
    if (until && until + DAY < Date.now()) return "expired";
    return "pro";
  }
  if (TRIAL_DAYS > 0 && new Date(u.created_at).getTime() + TRIAL_DAYS * DAY < Date.now()) return "expired";
  return "trial";
}

async function listUsers() {
  let all = [];
  for (let p = 1; p <= 20; p++) {
    const r = await fetch(SB_URL + "/auth/v1/admin/users?page=" + p + "&per_page=1000", { headers: sh() });
    if (!r.ok) throw new Error("Gagal membaca pengguna (" + r.status + "). Cek SUPABASE_SERVICE_ROLE_KEY.");
    const j = await r.json();
    const rows = j.users || [];
    all = all.concat(rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function rest(path, opt) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, Object.assign({ headers: sh() }, opt || {}));
  return r;
}

async function setPlan(id, meta) {
  const r = await fetch(SB_URL + "/auth/v1/admin/users/" + id, {
    method: "PUT", headers: sh(), body: JSON.stringify({ app_metadata: meta })
  });
  if (!r.ok) throw new Error("Gagal mengubah paket (" + r.status + ").");
}

async function markRequests(filter, status) {
  const r = await rest("pro_requests?" + filter, {
    method: "PATCH", headers: sh({ Prefer: "return=minimal" }),
    body: JSON.stringify({ status, handled_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error("Gagal memperbarui pengajuan (" + r.status + ").");
}

module.exports = async (req, res) => {
  const out = (code, obj) => res.status(code).json(obj);
  try {
    if (req.method !== "POST") return out(405, { error: "Metode tidak diizinkan." });
    if (!SERVICE) return out(500, { error: "SUPABASE_SERVICE_ROLE_KEY belum diisi di Environment Variables Vercel." });
    const admin = await who(req);
    if (!admin) return out(403, { error: "Khusus admin." });
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const uid = b.user_id, rid = b.request_id;

    if (b.action === "overview") {
      const users = await listUsers();
      const rr = await rest("pro_requests?select=id,user_id,email,status,created_at&order=created_at.desc&limit=300");
      const requests = rr.ok ? await rr.json() : [];
      let vs = {};
      try { const v = await rest("rpc/visit_stats", { method: "POST", body: "{}" }); if (v.ok) vs = await v.json(); } catch (e) {}
      const rows = users.map(u => ({
        id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at, plan: planOf(u),
        promo: (u.app_metadata || {}).promo === "early" && planOf(u) === "pro"
      })).sort((a, c) => new Date(c.created_at) - new Date(a.created_at));
      const cnt = k => rows.filter(u => u.plan === k).length;
      const stats = {
        views: vs.views == null ? null : vs.views, unique: vs.unique == null ? null : vs.unique, today: vs.today == null ? null : vs.today,
        users: rows.length, new7: rows.filter(u => Date.now() - new Date(u.created_at) < 7 * DAY).length,
        pro: cnt("pro"), trial: cnt("trial"), expired: cnt("expired"),
        pending: requests.filter(r => r.status === "pending").length,
        promo: rows.filter(u => u.promo).length, quota: QUOTA
      };
      return out(200, { stats, users: rows, requests });
    }

    if (b.action === "approve" || b.action === "grant") {
      if (!UUID.test(uid || "")) return out(400, { error: "user_id tidak valid." });
      if (b.promo) {
        const sold = (await listUsers()).filter(u => (u.app_metadata || {}).promo === "early" && planOf(u) === "pro").length;
        if (sold >= QUOTA) return out(409, { error: "Slot promo sudah habis. Hilangkan centang promo lalu coba lagi." });
      }
      await setPlan(uid, { plan: "pro", pro_until: null, promo: b.promo ? "early" : null });
      await markRequests("user_id=eq." + uid + "&status=eq.pending", "approved");
      return out(200, { ok: true });
    }
    if (b.action === "revoke") {
      if (!UUID.test(uid || "")) return out(400, { error: "user_id tidak valid." });
      await setPlan(uid, { plan: "free", pro_until: null, promo: null });
      return out(200, { ok: true });
    }
    if (b.action === "reject") {
      if (!UUID.test(rid || "")) return out(400, { error: "request_id tidak valid." });
      await markRequests("id=eq." + rid, "rejected");
      return out(200, { ok: true });
    }
    return out(400, { error: "Aksi tidak dikenal." });
  } catch (e) {
    return out(500, { error: e.message || "Kesalahan server." });
  }
};
