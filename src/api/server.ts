// Single source of truth for the boardgame.io server URL the browser uses.
// In dev, vite.config.ts proxies /api, /games, and /socket.io to :8000, so the
// origin is the same as the page (proxy hides the port). In production the
// frontend is served by the Koa server itself, so window.location.origin is
// always correct unless overridden with VITE_BGIO_SERVER (e.g. cross-origin
// deployment of the static client).

export const MULTIPLAYER_SERVER: string =
  import.meta.env.VITE_BGIO_SERVER?.trim() || window.location.origin;

export const API_BASE: string = import.meta.env.VITE_API_BASE?.trim() || '';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
