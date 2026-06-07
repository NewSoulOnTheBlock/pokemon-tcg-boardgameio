// Lobby trollbox — a tiny public chat for the matchmaking page.
//
// Two storage backends mirror the existing profile/card storage layout:
// PostgresLobbyChatStore for production, MemoryLobbyChatStore for local
// dev when there's no DATABASE_URL. Both keep at most MAX_MESSAGES in
// memory so the GET endpoint can return them without hitting the DB
// every poll.

import { Pool, type PoolConfig } from 'pg';

export interface LobbyChatMessage {
  id: string;
  userId: string;
  name: string;
  text: string;
  postedAt: string; // ISO-8601
}

export interface PostMessageInput {
  userId: string;
  name: string;
  text: string;
  postedFromIp?: string;
}

export interface LobbyChatStore {
  connect(): Promise<void>;
  recent(since?: string, limit?: number): Promise<LobbyChatMessage[]>;
  post(input: PostMessageInput): Promise<LobbyChatMessage>;
}

const LOBBY_TABLE = 'app_lobby_chat';
const MAX_MESSAGES = 200;
const RATE_LIMIT_MS = 2_500;
const MAX_LENGTH = 280;

export function sanitizeChatText(raw: string): string {
  // Collapse arbitrary whitespace (including newlines) to single spaces
  // so a single message doesn't blow out the chat layout.
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH);
}

export class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Rate limited; retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Per-key rate limiter. Key = userId|ip. Falls back to a single user if
// IP isn't available (e.g. local dev). Shared across both Postgres and
// memory stores so the limiter behaviour is identical regardless of
// backend.
function makeRateLimiter() {
  const lastPostAt = new Map<string, number>();
  // Periodic GC so the map doesn't grow unbounded. Runs every minute;
  // entries older than 5 minutes are dropped.
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of lastPostAt.entries()) {
      if (now - ts > 5 * 60_000) lastPostAt.delete(key);
    }
  }, 60_000);
  if (typeof interval === 'object' && interval !== null && 'unref' in interval) {
    (interval as NodeJS.Timeout).unref();
  }
  return {
    check(key: string) {
      const now = Date.now();
      const previous = lastPostAt.get(key);
      if (previous !== undefined && now - previous < RATE_LIMIT_MS) {
        throw new RateLimitError(RATE_LIMIT_MS - (now - previous));
      }
      lastPostAt.set(key, now);
    },
  };
}

function validatePostInput(input: PostMessageInput): { name: string; text: string; userId: string } {
  const userId = (input.userId ?? '').trim();
  const name = (input.name ?? '').trim().slice(0, 32);
  const text = sanitizeChatText(input.text ?? '');
  if (!userId) throw new ValidationError('userId required');
  if (!name) throw new ValidationError('name required');
  if (!text) throw new ValidationError('message empty');
  return { userId, name, text };
}

function rateLimitKey(userId: string, ip?: string): string {
  return ip ? `${userId}|${ip}` : userId;
}

function compareIsoDesc(a: LobbyChatMessage, b: LobbyChatMessage): number {
  return Date.parse(b.postedAt) - Date.parse(a.postedAt);
}

// ============================================================================
// Postgres
// ============================================================================

export class PostgresLobbyChatStore implements LobbyChatStore {
  private pool: Pool;
  private rateLimiter = makeRateLimiter();
  // In-memory cache of the most recent N messages so GET requests don't
  // round-trip to Postgres on every poll. Hydrated on connect().
  private cache: LobbyChatMessage[] = [];

  constructor(connectionString: string, ssl?: PoolConfig['ssl']) {
    this.pool = new Pool({ connectionString, ssl });
  }

  async connect(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${LOBBY_TABLE} (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        posted_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_${LOBBY_TABLE}_posted_at ON ${LOBBY_TABLE} (posted_at DESC)`);

    // Hydrate the in-memory cache so first GET after a deploy isn't empty.
    const { rows } = await this.pool.query<{ id: string; user_id: string; name: string; text: string; posted_at: Date }>(
      `SELECT id, user_id, name, text, posted_at FROM ${LOBBY_TABLE} ORDER BY posted_at DESC LIMIT $1`,
      [MAX_MESSAGES],
    );
    this.cache = rows
      .map((row) => ({
        id: String(row.id),
        userId: row.user_id,
        name: row.name,
        text: row.text,
        postedAt: new Date(row.posted_at).toISOString(),
      }))
      .sort(compareIsoDesc);
  }

  async recent(since?: string, limit?: number): Promise<LobbyChatMessage[]> {
    const cap = Math.min(limit ?? MAX_MESSAGES, MAX_MESSAGES);
    const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
    return this.cache
      .filter((message) => !since || Date.parse(message.postedAt) > sinceMs)
      .slice(0, cap);
  }

  async post(input: PostMessageInput): Promise<LobbyChatMessage> {
    const { userId, name, text } = validatePostInput(input);
    this.rateLimiter.check(rateLimitKey(userId, input.postedFromIp));
    const { rows } = await this.pool.query<{ id: string; posted_at: Date }>(
      `INSERT INTO ${LOBBY_TABLE} (user_id, name, text) VALUES ($1, $2, $3) RETURNING id, posted_at`,
      [userId, name, text],
    );
    const row = rows[0];
    const message: LobbyChatMessage = {
      id: String(row.id),
      userId,
      name,
      text,
      postedAt: new Date(row.posted_at).toISOString(),
    };
    this.cache = [message, ...this.cache].slice(0, MAX_MESSAGES);
    // Trim the table opportunistically so it doesn't grow unbounded —
    // keep the most recent ~10 * MAX_MESSAGES rows for moderation audit
    // history, drop the rest.
    void this.pool.query(
      `DELETE FROM ${LOBBY_TABLE} WHERE id NOT IN (SELECT id FROM ${LOBBY_TABLE} ORDER BY posted_at DESC LIMIT $1)`,
      [MAX_MESSAGES * 10],
    ).catch((err) => console.warn('[lobbyChat] trim failed:', err));
    return message;
  }
}

// ============================================================================
// Memory (local dev / no DATABASE_URL)
// ============================================================================

export class MemoryLobbyChatStore implements LobbyChatStore {
  private rateLimiter = makeRateLimiter();
  private messages: LobbyChatMessage[] = [];
  private counter = 0;

  async connect(): Promise<void> {
    /* no-op */
  }

  async recent(since?: string, limit?: number): Promise<LobbyChatMessage[]> {
    const cap = Math.min(limit ?? MAX_MESSAGES, MAX_MESSAGES);
    const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
    return this.messages
      .filter((message) => !since || Date.parse(message.postedAt) > sinceMs)
      .slice(0, cap);
  }

  async post(input: PostMessageInput): Promise<LobbyChatMessage> {
    const { userId, name, text } = validatePostInput(input);
    this.rateLimiter.check(rateLimitKey(userId, input.postedFromIp));
    this.counter += 1;
    const message: LobbyChatMessage = {
      id: `mem-${this.counter}`,
      userId,
      name,
      text,
      postedAt: new Date().toISOString(),
    };
    this.messages = [message, ...this.messages].slice(0, MAX_MESSAGES);
    return message;
  }
}

// Convenience constants exposed for the client + tests.
export const LOBBY_CHAT_LIMITS = {
  MAX_LENGTH,
  MAX_MESSAGES,
  RATE_LIMIT_MS,
} as const;
