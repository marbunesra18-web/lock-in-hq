// /api/claude — forwards the app's AI requests to Google Gemini using YOUR key.
// Set GEMINI_API_KEY in Netlify: Project configuration → Environment variables.
// Optional: GEMINI_MODEL / GEMINI_MODEL_QUICK to pin models (otherwise the newest Flash / Flash-Lite is picked).
// Optional: LOCKIN_ALLOWED_ORIGINS = comma-separated extra origins allowed to call this (your site URL is always allowed).
// The app (shim.js) still speaks the same request/response shape as before; this file translates it to Gemini.

const API = "https://generativelanguage.googleapis.com/v1beta";
const VERTEX = "https://aiplatform.googleapis.com/v1/publishers/google/models";
let modelCache = null;
let useVertex = false;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function originOk(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const allowed = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL, "https://appassets.androidplatform.net",
    ...(process.env.LOCKIN_ALLOWED_ORIGINS || "").split(",")].filter(Boolean).map(s => s.trim().replace(/\/$/, ""));
  return allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
}

function newest(ids, re) {
  let best = null, bestV = -1;
  for (const id of ids) {
    const m = id.match(re);
    if (m && +m[1] > bestV) { bestV = +m[1]; best = id; }
  }
  return best;
}

async function pickModels(key) {
  if (modelCache) return modelCache;
  let ids = [];
  try {
    const r = await fetch(API + "/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
    if (r.ok) ids = ((await r.json()).models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""));
  } catch (e) {}
  const flash = newest(ids, /^gemini-(\d+(?:\.\d+)?)-flash$/) || "gemini-2.5-flash";
  const lite = newest(ids, /^gemini-(\d+(?:\.\d+)?)-flash-lite$/) || flash;
  modelCache = { default: process.env.GEMINI_MODEL || flash, quick: process.env.GEMINI_MODEL_QUICK || lite };
  return modelCache;
}

// ---- Anthropic-style messages -> Gemini contents ----
function toContents(messages) {
  const names = {}; // tool_use id -> function name
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content || []);
    const parts = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === "text" && b.text) parts.push({ text: b.text });
      else if (b.type === "image" && b.source && b.source.data) parts.push({ inlineData: { mimeType: b.source.media_type || "image/jpeg", data: b.source.data } });
      else if (b.type === "tool_use") {
        names[b.id] = b.name;
        const p = { functionCall: { name: b.name, args: b.input || {} } };
        if (b.thought_signature) p.thoughtSignature = b.thought_signature;
        parts.push(p);
      } else if (b.type === "tool_result") {
        let out = b.content;
        if (Array.isArray(out)) out = out.map(x => x.text || "").join("");
        parts.push({ functionResponse: { name: names[b.tool_use_id] || "tool", response: b.is_error ? { error: String(out) } : { result: out } } });
      }
    }
    if (!parts.length) parts.push({ text: "(empty)" });
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

// ---- Gemini response -> Anthropic-style blocks ----
function fromCandidate(cand) {
  const content = [];
  let n = 0;
  for (const p of (cand && cand.content && cand.content.parts) || []) {
    if (p.thought) continue;
    if (p.text) {
      const last = content[content.length - 1];
      if (last && last.type === "text") last.text += p.text; else content.push({ type: "text", text: p.text });
    } else if (p.functionCall) {
      const b = { type: "tool_use", id: "call_" + Date.now().toString(36) + "_" + (n++), name: p.functionCall.name, input: p.functionCall.args || {} };
      if (p.thoughtSignature) b.thought_signature = p.thoughtSignature;
      content.push(b);
    }
  }
  const fr = cand && cand.finishReason;
  const stop_reason = content.some(b => b.type === "tool_use") ? "tool_use"
    : fr === "MAX_TOKENS" ? "max_tokens"
    : /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(fr || "") ? "refusal" : "end_turn";
  return { content, stop_reason };
}

async function callGemini(key, model, body) {
  const url = useVertex ? `${VERTEX}/${model}:generateContent` : `${API}/models/${model}:generateContent`;
  const r = await fetch(url, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { r, j };
}

export default async (req) => {
  if (req.method !== "POST") return json({ code: "method" }, 405);
  if (!originOk(req)) return json({ code: "not_granted" }, 403);
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return json({ code: "sampling_disabled", message: "GEMINI_API_KEY is not set on Netlify" }, 500);

  const raw = await req.text();
  if (raw.length > 12_000_000) return json({ code: "prompt_too_large" }, 413);
  let b; try { b = JSON.parse(raw); } catch (e) { return json({ code: "bad_request" }, 400); }

  const models = await pickModels(key);
  const model = b.tier === "quick" ? models.quick : models.default;
  const fnTools = (Array.isArray(b.tools) ? b.tools.slice(0, 20) : []).map(t => ({
    name: t.name, description: t.description || "", parametersJsonSchema: t.input_schema || { type: "object", properties: {} }
  }));
  const tools = [];
  if (fnTools.length) tools.push({ functionDeclarations: fnTools });
  else if (b.webSearch) tools.push({ googleSearch: {} });

  const body = {
    contents: toContents(Array.isArray(b.messages) ? b.messages.slice(-40) : []),
    generationConfig: { maxOutputTokens: Math.min(Math.max(+b.max_tokens || 2048, 256), 8000) },
    ...(b.system ? { systemInstruction: { parts: [{ text: String(b.system).slice(0, 20000) }] } } : {}),
    ...(tools.length ? { tools } : {})
  };

  let r, j;
  try {
    ({ r, j } = await callGemini(key, model, body));
    // Some Google keys (e.g. ones starting with "AQ.") only work on Vertex AI — retry there once.
    if (!useVertex && (r.status === 401 || r.status === 403 || (r.status === 400 && /api key/i.test(JSON.stringify(j || ""))))) {
      useVertex = true;
      const second = await callGemini(key, model, body);
      if (second.r.ok) ({ r, j } = second); else useVertex = false;
    }
  } catch (e) {
    return json({ code: "network" }, 502);
  }
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || "";
    if (r.status === 404) modelCache = null;
    const code = r.status === 429 || r.status === 503 ? "rate_limited"
      : r.status === 413 || /too long|too large|exceed/i.test(msg) ? "prompt_too_large"
      : /image/i.test(msg) ? "image_rejected"
      : r.status === 401 || r.status === 403 || /api key/i.test(msg) ? "sampling_disabled" : "api_error";
    return json({ code, message: msg }, r.status);
  }
  if (j && j.promptFeedback && j.promptFeedback.blockReason && !(j.candidates || []).length)
    return json({ content: [], stop_reason: "refusal", model });
  const out = fromCandidate((j.candidates || [])[0]);
  return json({ ...out, model });
};

export const config = { path: "/api/claude" };
