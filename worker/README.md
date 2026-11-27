# Claude chat proxy

`Index.html` is a static page on GitHub Pages, so it can't hold an Anthropic API key: anyone could read it from the page source. This small Cloudflare Worker keeps the key secret. The page sends the chat to the Worker, the Worker calls Claude and streams the reply back.

```
browser (GitHub Pages)  --POST {messages, context}-->  Worker (holds the key)  -->  Claude API
                        <------- streamed text ------
```

## Setup (about 5 minutes, free Cloudflare account)

1. Get an API key at https://platform.claude.com (Settings → API keys). Usage is billed to that account.
2. In this `worker` folder:

   ```
   npm install
   npx wrangler login
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler deploy
   ```

   `wrangler deploy` prints a URL like `https://yyy-claude-chat.<your-subdomain>.workers.dev`.
3. Put that URL in `Index.html`, in `CFG.chatUrl`, then commit and push.
4. Open the page, click in, press **T** (or **Enter**) and type.

## Settings

- `wrangler.toml` → `ALLOWED_ORIGINS`: the only sites allowed to call the Worker. It's set to `https://y0n4s.github.io`. To test locally, add your local address, for example `"https://y0n4s.github.io,http://localhost:8000"`.
- `src/index.js`:
  - `MODEL`: `claude-opus-5-5`
  - `MAX_TOKENS`: the most each reply can cost
  - `effort: "low"`: keeps casual chat quick and cheap
  - `RATE`: how many messages per minute each visitor can send
  - `SYSTEM`: Claude's instructions inside the world
- Server-side refusal fallback (`fallbacks: "default"`) is on. If a safety check declines a message, the same request is retried on a fallback model instead of failing.

## Limits to know about

- The origin check stops other websites from using your Worker in a browser. It does **not** stop someone who calls the Worker URL directly with a script. The per-IP rate limit and `MAX_TOKENS` cap how much that can cost. To control spend, also set a monthly spend limit for the key on the Claude Console.
- The rate limit is kept in memory by each Worker instance, so it is approximate. For strict limits, use Cloudflare's Rate Limiting binding or a Durable Object.
- The page sends your approximate position in the world (latitude/longitude rounded to about 100 m, heading, map scale) with each message, so Claude can talk about where you are. Remove `context` from the `fetch` in `Index.html` if you don't want that.

## Local testing

```
npx wrangler dev
```

This runs the Worker at `http://localhost:8787`. Put your key in a `.dev.vars` file (`ANTHROPIC_API_KEY=...`); it's ignored by git. Then open the page with `?chat=http://localhost:8787` added to the URL.
