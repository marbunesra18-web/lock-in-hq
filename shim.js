/* Lock In HQ — standalone shim.
   Outside claude.ai there is no window.claude, so this file provides the same
   small API the app uses, backed by your own Netlify functions:
     /api/claude  -> AI (your Anthropic API key, kept on the server)
     /api/markets -> IDX / market prices
   Data is saved in the browser (localStorage) by the app itself. */
(function () {
  if (window.claude) return; // running inside claude.ai: use the real thing
  window.LOCKIN_APP = true;
  window.LOCKIN_API = window.LOCKIN_API || "/api/claude";

  const MAX_TOOL_ROUNDS = 6;

  function err(code, text) { const e = new Error(code); e.code = code; if (text) e.text = text; return e; }

  function blobToB64(b) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result); res({ type: (s.match(/^data:([^;]+)/) || [])[1] || b.type || "image/jpeg", data: s.slice(s.indexOf(",") + 1) }); };
      r.onerror = () => rej(err("image_rejected"));
      r.readAsDataURL(b);
    });
  }

  function toMessages(input) {
    if (typeof input === "string") return [{ role: "user", content: input }];
    const out = [];
    (input || []).forEach(m => {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content = typeof m.content === "string" ? m.content : m.content;
      const last = out[out.length - 1];
      // the API needs alternating roles: merge consecutive same-role text turns
      if (last && last.role === role && typeof last.content === "string" && typeof content === "string") last.content += "\n\n" + content;
      else out.push({ role, content });
    });
    if (out.length && out[0].role !== "user") out.unshift({ role: "user", content: "(start)" });
    return out;
  }

  async function addImages(messages, images) {
    if (!images) return;
    const list = (Array.isArray(images) ? images : [images]).filter(Boolean).slice(0, 8);
    if (!list.length) return;
    const blocks = [];
    for (const b of list) {
      const { type, data } = await blobToB64(b);
      blocks.push({ type: "image", source: { type: "base64", media_type: /^image\/(jpeg|png|gif|webp)$/.test(type) ? type : "image/jpeg", data } });
    }
    let last = messages[messages.length - 1];
    if (!last || last.role !== "user") { last = { role: "user", content: "" }; messages.push(last); }
    const text = typeof last.content === "string" ? [{ type: "text", text: last.content || "Look at this." }] : last.content;
    last.content = [...blocks, ...text];
  }

  async function callApi(body, signal) {
    let r;
    try {
      r = await fetch(window.LOCKIN_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e && e.name === "AbortError") throw err("cancelled");
      throw err("network");
    }
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw err((j && j.code) || (r.status === 429 ? "rate_limited" : "http_" + r.status));
    return j;
  }

  async function sample(input, opts) {
    opts = opts || {};
    const messages = toMessages(input);
    await addImages(messages, opts.images);
    const tools = (opts.tools || []).map(t => ({ name: t.name, description: t.description || "", input_schema: t.inputSchema || { type: "object", properties: {} } }));
    const byName = Object.fromEntries((opts.tools || []).map(t => [t.name, t]));
    let text = "";
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await callApi({
        tier: opts.modelTier === "quick" ? "quick" : "default",
        system: opts.system || undefined,
        messages,
        tools,
        webSearch: !!opts.webSearch,
        max_tokens: opts.maxTokens || 2048
      }, opts.signal);
      const blocks = res.content || [];
      const t = blocks.filter(b => b.type === "text").map(b => b.text).join("");
      if (t) { text += (text ? "\n\n" : "") + t; if (opts.onText) try { opts.onText({ text }); } catch (e) {} }
      if (res.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: blocks }); continue; } // long web search
      const uses = blocks.filter(b => b.type === "tool_use" && byName[b.name]);
      if (res.stop_reason !== "tool_use" || !uses.length) {
        if (res.stop_reason === "refusal" && !text) throw err("refused");
        return { text };
      }
      messages.push({ role: "assistant", content: blocks });
      const results = [];
      for (const u of uses) {
        let out, isErr = false;
        try { out = await byName[u.name].execute(u.input || {}); } catch (e) { out = String((e && e.message) || e); isErr = true; }
        results.push({ type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out ?? "ok"), is_error: isErr });
      }
      messages.push({ role: "user", content: results });
    }
    return { text };
  }

  function looseJSON(s) {
    s = String(s || "").replace(/```(?:json)?/gi, "").trim();
    try { return JSON.parse(s); } catch (e) {}
    const a = s.indexOf("["), o = s.indexOf("{");
    const start = a < 0 ? o : o < 0 ? a : Math.min(a, o);
    if (start < 0) throw err("invalid_json");
    const end = Math.max(s.lastIndexOf("]"), s.lastIndexOf("}"));
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { throw err("invalid_json"); }
  }

  sample.json = async (input, opts) => {
    const add = "\n\nReply with ONLY valid JSON. No other words, no code fences.";
    const inp = typeof input === "string" ? input + add : input;
    const { text } = await sample(inp, { maxTokens: 4096, ...(opts || {}) });
    return looseJSON(text);
  };
  sample.limits = async () => ({ tools: true, images: true });

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([typeof data === "string" ? data : JSON.stringify(data)], { type: "application/octet-stream" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename || "download";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
  };

  window.claude = {
    standalone: true,
    async use(name) {
      if (name === "sample") return sample;
      if (name === "downloads") return downloads;
      return null; // db, user, permissions: not used outside Claude (data stays on this device)
    }
  };

  // PWA: offline support
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }
})();
