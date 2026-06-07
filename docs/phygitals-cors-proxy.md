# Phygitals CORS Proxy — deployment guide

`api.phygitals.com` doesn't allow CORS for `pokemasterstcg.xyz`, so the
browser-direct calls from our Boosters page get blocked with "Failed
to fetch". This Cloudflare Worker proxies the calls and adds the
right CORS headers.

## Why a Worker (and not our Render server)

Phygitals' Cloudflare WAF blocks Render's outbound IPs at the edge —
that's how we got here in the first place. Cloudflare Workers run on
CF infrastructure, so the WAF lets them through. Bonus: 100k free
requests/day, no cold-starts, no maintenance.

## Deploy (one-time, ~5 minutes)

1. Open [Cloudflare dashboard](https://dash.cloudflare.com) (free account is fine)
2. Left sidebar → **Workers & Pages** → **Create application** → **Create Worker**
3. Name it something like `phygitals-proxy`. Click **Deploy** (it ships a stub).
4. Click **Edit code** on the deployed Worker.
5. Replace the entire stub with the contents of `docs/phygitals-cors-proxy.worker.js` in this repo.
6. Click **Deploy** in the top-right.
7. Note the Worker URL — usually `https://phygitals-proxy.<your-handle>.workers.dev`

## Wire it into the app

1. https://dashboard.render.com → `pokemon-tcg-boardgameio` → **Environment**
2. Update the `VITE_PHYGITALS_BASE_URL` env var to your Worker URL (e.g. `https://phygitals-proxy.openclawagent.workers.dev`)
3. Save → Render rebuilds (~3 min) → the browser bundle now points at the Worker
4. The Boosters page Shop tab should populate

## Quick verify

After Render redeploys, open https://pokemasterstcg.xyz → DevTools → Network. You should see successful 200s on calls to your Worker URL, not 403/CORS errors.

## Lock down origins (optional but recommended)

The Worker only forwards calls when the request `Origin` header is in
the `ALLOWED_ORIGINS` array at the top of the file. Default is:
- `https://pokemasterstcg.xyz`
- `https://www.pokemasterstcg.xyz`
- `http://localhost:5173` (Vite dev server)
- `http://localhost:3000`

Add or remove entries as needed and redeploy the Worker. This stops
random third parties from using your Worker as a free Phygitals proxy.

## Long-term clean fix

Email partners@phygitals.com and ask them to add `pokemasterstcg.xyz`
to their CORS allowlist on `api.phygitals.com`. Once they do, you can
delete the Worker and point `VITE_PHYGITALS_BASE_URL` back at
`https://api.phygitals.com`.
