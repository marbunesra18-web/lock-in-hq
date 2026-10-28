// /api/claude — forwards the app's AI requests to Anthropic using YOUR key.
// Set ANTHROPIC_API_KEY in Netlify: Site configuration → Environment variables.
// Optional: CLAUDE_MODEL / CLAUDE_MODEL_QUICK to pin models (otherwise the newest Sonnet / Haiku is picked).
// Optional: LOCKIN_ALLOWED_ORIGINS = comma-separated extra origins allowed to call this (your site URL is always allowed).

const API = "https://api.anthropic.com/v1";
let modelCache = null;

async function pickModels(key) {
  if (modelCache) return modelCache;
  let ids = [];
  try {
    const r = await fetch(API + "/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    if (r.ok) ids = ((await r.json()).data || []).map(m => m.id); // newest first
  } catch (e) {}
  const find = w => ids.find(id => id.includes(w));
  modelCache = {
    default: process.env.CLAUDE_MODEL || find("sonnet") || find("opus") || ids[0] || "claude-sonnet-4-5",
    quick: process.env.CLAUDE_MODEL_QUICK || find("haiku") || find("sonnet") || ids[0] || "claude-haiku-4-5"
  };
  return modelCache;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function originOk(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin GET-less fetches from the Android wrapper may omit it
  const allowed = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL, "https://appassets.androidplatform.net",
    ...(process.env.LOCKIN_ALLOWED_ORIGINS || "").split(",")].filter(Boolean).map(s => s.trim().replace(/\/$/, ""));
  return allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
}

export default async (req) => {
  if (req.method !== "POST") return json({ code: "method" }, 405);
  if (!originOk(req)) return json({ code: "not_granted" }, 403);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ code: "sampling_disabled", message: "ANTHROPIC_API_KEY is not set on Netlify" }, 500);

  const raw = await req.text();
  if (raw.length > 12_000_000) return json({ code: "prompt_too_large" }, 413);
  let b; try { b = JSON.parse(raw); } catch (e) { return json({ code: "bad_request" }, 400); }

  const models = await pickModels(key);
  const tools = Array.isArray(b.tools) ? b.tools.slice(0, 20) : [];
  if (b.webSearch) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 3 });

  const body = {
    model: b.tier === "quick" ? models.quick : models.default,
    max_tokens: Math.min(Math.max(+b.max_tokens || 2048, 256), 8000),
    messages: Array.isArray(b.messages) ? b.messages.slice(-40) : [],
    ...(b.system ? { system: String(b.system).slice(0, 20000) } : {}),
    ...(tools.length ? { tools } : {})
  };

  let r, j;
  try {
    r = await fetch(API + "/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    j = await r.json();
  } catch (e) {
    return json({ code: "network" }, 502);
  }
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || "";
    if (r.status === 404 && /model/i.test(msg)) modelCache = null; // re-pick next time
    const code = r.status === 429 || r.status === 529 ? "rate_limited"
      : r.status === 413 || /too long|too large|exceed/i.test(msg) ? "prompt_too_large"
      : /image/i.test(msg) ? "image_rejected"
      : r.status === 401 ? "sampling_disabled" : "api_error";
    return json({ code, message: msg }, r.status);
  }
  return json({ content: j.content, stop_reason: j.stop_reason, model: j.model });
};

export const config = { path: "/api/claude" };
