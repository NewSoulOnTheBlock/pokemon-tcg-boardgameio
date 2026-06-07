// Cloudflare Worker proxy for api.phygitals.com.
//
// Why: Phygitals' CORS allowlist accepts phygitals.com + localhost but
// not partner domains by default, and their Cloudflare WAF rejects
// many cloud-provider outbound IPs (e.g. Render). Cloudflare Workers
// IPs aren't blocked because they're CF infra, and the Worker adds
// permissive CORS headers so the browser stops blocking responses.
//
// Deploy:
//   1. Cloudflare dashboard → Workers & Pages → Create → Worker
//   2. Paste this file, click Deploy
//   3. Note the URL (e.g. phygitals-proxy.<your-handle>.workers.dev)
//   4. Set VITE_PHYGITALS_BASE_URL on Render to that URL
//   5. Render rebuilds, the browser now calls the Worker which
//      forwards to api.phygitals.com
//
// Security note: this Worker forwards X-API-Key as-is from the browser
// to Phygitals. The key is still visible in DevTools — the Worker
// doesn't hide it. If you want server-held secrets, you'd need a
// different topology (server holds key, Worker proxies via auth
// shared-secret, etc).

const PHYGITALS_ORIGIN = 'https://api.phygitals.com';

// Allowed origins for CORS. Add your domains here. Leave '*' if you're
// fine with any site using your Worker (typically you'd lock this
// down to your own UI origins).
const ALLOWED_ORIGINS = [
  'https://pokemasterstcg.xyz',
  'https://www.pokemasterstcg.xyz',
  'http://localhost:5173',
  'http://localhost:3000',
];

function corsHeadersFor(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-API-Key,Accept,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeadersFor(request) });
    }

    // Forward everything under /api/* to api.phygitals.com/api/*.
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not Found', { status: 404 });
    }

    const upstream = new URL(PHYGITALS_ORIGIN + url.pathname + url.search);

    // Copy request headers, drop hop-by-hop ones, ensure X-API-Key
    // is forwarded as-is. (Workers fetch handles host correctly.)
    const upstreamHeaders = new Headers();
    for (const [k, v] of request.headers) {
      const lower = k.toLowerCase();
      if (['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip'].includes(lower)) continue;
      upstreamHeaders.set(k, v);
    }
    // Belt-and-suspenders: tell Phygitals' CDN this looks like a real browser.
    if (!upstreamHeaders.get('User-Agent')) {
      upstreamHeaders.set('User-Agent', 'Mozilla/5.0 (compatible; PhygitalsProxyWorker/1.0)');
    }

    const init = {
      method: request.method,
      headers: upstreamHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'follow',
    };

    const upstreamResp = await fetch(upstream.toString(), init);

    // Pass the upstream body + status through, but replace CORS headers
    // with our own permissive set so the browser stops blocking it.
    const respHeaders = new Headers(upstreamResp.headers);
    for (const [k, v] of Object.entries(corsHeadersFor(request))) {
      respHeaders.set(k, v);
    }
    // Drop Phygitals' CORS headers in favour of ours.
    respHeaders.delete('access-control-allow-origin');
    for (const [k, v] of Object.entries(corsHeadersFor(request))) {
      respHeaders.set(k, v);
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
  },
};
