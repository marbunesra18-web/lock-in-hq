// /api/markets?symbols=BBCA.JK,^JKSE&range=1d — live-ish prices for the Saham tab (Yahoo Finance chart data).
// Returns { at, quotes: { SYMBOL: { price, prev, pct, spark:[...], name } } }

const RANGES = { "1d": "5m", "5d": "30m", "1mo": "1d", "6mo": "1d", "1y": "1wk" };

async function one(sym, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${RANGES[range]}`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 LockInHQ" } });
  if (!r.ok) return null;
  const res = (await r.json())?.chart?.result?.[0];
  if (!res) return null;
  const m = res.meta || {};
  const closes = (res.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  const price = m.regularMarketPrice ?? closes[closes.length - 1] ?? null;
  const prev = range === "1d" ? (m.chartPreviousClose ?? m.previousClose ?? closes[0]) : closes[0];
  const pct = price != null && prev ? ((price - prev) / prev) * 100 : null;
  const step = Math.max(1, Math.ceil(closes.length / 120));
  return { price, prev, pct, spark: closes.filter((_, i) => i % step === 0 || i === closes.length - 1), name: m.shortName || m.longName || sym };
}

export default async (req) => {
  const u = new URL(req.url);
  const range = RANGES[u.searchParams.get("range")] ? u.searchParams.get("range") : "1d";
  const syms = [...new Set((u.searchParams.get("symbols") || "").split(",").map(s => s.trim()).filter(s => /^[\^A-Za-z0-9.=\-]{1,20}$/.test(s)))].slice(0, 40);
  const quotes = {};
  await Promise.all(syms.map(async s => { try { const q = await one(s, range); if (q) quotes[s] = q; } catch (e) {} }));
  return new Response(JSON.stringify({ at: Date.now(), quotes }), {
    headers: { "content-type": "application/json", "cache-control": range === "1d" ? "public, max-age=60" : "public, max-age=900" }
  });
};

export const config = { path: "/api/markets" };
