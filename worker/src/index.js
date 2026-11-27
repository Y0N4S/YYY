/* Claude chat proxy for the first-person world (Cloudflare Worker).
   The browser POSTs { messages, context } here; this Worker adds the secret API key,
   calls Claude, and streams the reply back as plain text.

   Secrets / vars (see wrangler.toml and README.md):
     ANTHROPIC_API_KEY  - secret, set with `npx wrangler secret put ANTHROPIC_API_KEY`
     ALLOWED_ORIGINS    - comma-separated origins allowed to call this Worker */
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 2048;          // cost cap per reply on a public endpoint; chat replies are short
const MAX_MESSAGES = 30;          // history kept per request
const MAX_CHARS = 2000;           // per message
const RATE = { windowMs: 60_000, max: 12 };   // per IP, best effort (per Worker instance)
const MAX_IMAGE_B64 = 1_500_000;  // ~1.1 MB JPEG; the page sends ~100-200 KB

const SYSTEM = `You are Claude, talking with a visitor inside a small first-person 3D world that runs in their web browser.
The world is built from OpenStreetMap data around the visitor's real location: the ground is the street map and buildings are simple boxes extruded from OSM footprints.
They can walk (WASD), sprint, jump, crouch, climb onto roofs, and change the map scale.
Your replies appear in a small chat panel over the 3D view, so keep them short and conversational (usually 1-4 sentences), in plain text without Markdown.
A context note with the visitor's current state in the world may follow; use it when it is relevant, and don't recite it otherwise.
Their latest message may include a screenshot of exactly what they are looking at right now (first-person view; the white dot in the centre is the crosshair). Use it to answer questions like "what's that?" or "where should I go?". The ground texture is an OpenStreetMap street map, so you can often read street and place names from it. Buildings are untextured boxes, so don't guess at details they don't show.`;

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  h.push(now); hits.set(ip, h);
  return h.length > RATE.max;
}

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return { ok, headers: ok ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  } : {} };
}

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw.slice(-MAX_MESSAGES)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();          // must start with the user
  return msgs.length && msgs[msgs.length - 1].role === "user" ? msgs : null;
}

function contextNote(c) {
  if (!c || typeof c !== "object") return "";
  const parts = [];
  const num = v => typeof v === "number" && isFinite(v);
  if (num(c.lat) && num(c.lon)) parts.push(`approximate real-world location ${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`);
  else parts.push("no real location (flat demo ground)");
  if (num(c.heading)) parts.push(`facing ${Math.round(c.heading)}° from north`);
  if (num(c.scale)) parts.push(`map scale 1 m of floor = ${c.scale.toFixed(1)} m of map`);
  if (num(c.metresFromStart)) parts.push(`${Math.round(c.metresFromStart)} real metres from where they started`);
  if (num(c.height) && c.height > 0.5) parts.push(`standing ${c.height.toFixed(1)} m above the ground (likely on a roof)`);
  if (num(c.buildings)) parts.push(`${c.buildings} buildings loaded`);
  return parts.length ? `Visitor state: ${parts.join("; ")}.` : "";
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const { ok, headers } = cors(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers });
    if (request.method !== "POST") return json(405, { error: "POST only" }, headers);
    if (!ok) return json(403, { error: "Origin not allowed" }, headers);
    if (!env.ANTHROPIC_API_KEY) return json(500, { error: "ANTHROPIC_API_KEY secret is not set" }, headers);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip)) return json(429, { error: "Too many messages, wait a minute" }, headers);

    let body;
    try { body = await request.json(); } catch { return json(400, { error: "Bad JSON" }, headers); }
    const messages = cleanMessages(body.messages);
    if (!messages) return json(400, { error: "messages must be a non-empty list ending with a user message" }, headers);

    // Optional snapshot of the visitor's view, attached to their newest message only.
    const image = body.image;
    if (image != null) {
      if (typeof image !== "string" || image.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+=*$/.test(image) || !image.startsWith("/9j/"))
        return json(400, { error: "image must be base64 JPEG data under ~1 MB" }, headers);   // "/9j/" = JPEG magic bytes
      const last = messages[messages.length - 1];
      last.content = [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
        { type: "text", text: last.content },
      ];
    }

    const note = contextNote(body.context);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "low" },                   // casual chat: fast and cheap
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",                               // if a safety classifier declines, retry on a fallback model
      system: note ? [{ type: "text", text: SYSTEM }, { type: "text", text: note }] : SYSTEM,
      messages,
    });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter(), enc = new TextEncoder();
    (async () => {
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta")
            await writer.write(enc.encode(event.delta.text));
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") await writer.write(enc.encode("\n[I can't help with that one.]"));
        else if (final.stop_reason === "max_tokens") await writer.write(enc.encode(" …"));
      } catch (err) {
        const msg = err instanceof Anthropic.RateLimitError ? "Claude is busy right now, try again in a moment."
          : err instanceof Anthropic.AuthenticationError ? "The proxy's API key was rejected."
          : err instanceof Anthropic.APIError ? `Claude API error (${err.status ?? "network"}).`
          : "Proxy error.";
        console.error(err);
        try { await writer.write(enc.encode(`\n[${msg}]`)); } catch {}
      } finally {
        try { await writer.close(); } catch {}
      }
    })();

    return new Response(readable, {
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};
