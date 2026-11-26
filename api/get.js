const OK = ["cdn.islamic.network", "everyayah.com", "api.alquran.cloud", "api.quran.com", "verses.quran.com", "qtt.web.id"];

module.exports = async (req, res) => {
  try {
    const u = new URL(req.query.u);
    if (u.protocol !== "https:" || !OK.includes(u.hostname)) {
      res.status(400).send("host tidak diizinkan");
      return;
    }
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) {
      res.status(r.status).send("upstream " + r.status);
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800");
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).send("gagal: " + e.message);
  }
};
