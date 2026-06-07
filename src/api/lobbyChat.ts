// Browser-side wrapper for the /api/lobby/chat endpoints. Polls the GET
// endpoint on a timer from the matchmaking page, hits POST when the
// user sends a message.

import { apiUrl } from './server';

export interface LobbyChatMessage {
  id: string;
  userId: string;
  name: string;
  text: string;
  postedAt: string;
}

export interface LobbyChatLimits {
  MAX_LENGTH: number;
  MAX_MESSAGES: number;
  RATE_LIMIT_MS: number;
}

export class LobbyChatRateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Slow down — try again in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'LobbyChatRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export async function fetchLobbyChat(options?: { since?: string; limit?: number; signal?: AbortSignal }): Promise<{
  messages: LobbyChatMessage[];
  limits: LobbyChatLimits;
}> {
  const params = new URLSearchParams();
  if (options?.since) params.set('since', options.since);
  if (options?.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  const response = await fetch(apiUrl(`/api/lobby/chat${query ? `?${query}` : ''}`), {
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch lobby chat: ${response.status}`);
  }
  return response.json();
}

export async function postLobbyChat(input: { userId: string; name: string; text: string }): Promise<LobbyChatMessage> {
  const response = await fetch(apiUrl('/api/lobby/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (response.status === 429) {
    const body = await response.json().catch(() => ({ retryAfterMs: 2500 }));
    throw new LobbyChatRateLimitError(body.retryAfterMs ?? 2500);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(text || `Failed to send chat (${response.status})`);
  }
  const body = await response.json();
  return body.message as LobbyChatMessage;
}
