// Public matchmaking-lobby chat — the trollbox. Polls the server every
// few seconds for new messages, auto-scrolls when fresh ones land,
// rate-limit-aware input.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProfileState } from '../shared/profile';
import {
  fetchLobbyChat,
  LobbyChatRateLimitError,
  postLobbyChat,
  type LobbyChatLimits,
  type LobbyChatMessage,
} from '../api/lobbyChat';

const POLL_INTERVAL_MS = 4_000;
const DEFAULT_LIMITS: LobbyChatLimits = {
  MAX_LENGTH: 280,
  MAX_MESSAGES: 200,
  RATE_LIMIT_MS: 2_500,
};

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function mergeMessages(existing: LobbyChatMessage[], incoming: LobbyChatMessage[]): LobbyChatMessage[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((message) => message.id));
  const merged = [...existing];
  for (const message of incoming) {
    if (!seen.has(message.id)) {
      merged.push(message);
      seen.add(message.id);
    }
  }
  // Server returns newest-first; we display oldest-first so newest sits
  // at the bottom (like every chat app ever).
  merged.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  return merged;
}

export function TrollBox({ profile }: { profile: ProfileState }) {
  const [messages, setMessages] = useState<LobbyChatMessage[]>([]);
  const [limits, setLimits] = useState<LobbyChatLimits>(DEFAULT_LIMITS);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [nowTick, setNowTick] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickyBottomRef = useRef(true);

  // Re-render once a minute so the "12s ago" labels stay fresh without
  // re-fetching the message list.
  useEffect(() => {
    const interval = window.setInterval(() => setNowTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  void nowTick;

  // Initial fetch + polling loop.
  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function refresh() {
      try {
        const lastSeen = messagesRef.current[messagesRef.current.length - 1]?.postedAt;
        const result = await fetchLobbyChat({ since: lastSeen, signal: controller.signal });
        if (!active) return;
        setMessages((prev) => mergeMessages(prev, result.messages));
        setLimits(result.limits ?? DEFAULT_LIMITS);
        setLoaded(true);
      } catch (err) {
        if (!active) return;
        if ((err as Error).name === 'AbortError') return;
        // Network burps are fine for a polling chat; surface the next
        // success and stay quiet meanwhile.
        console.warn('[trollbox] poll failed:', err);
      }
    }

    void refresh();
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  // Mirror of messages into a ref so the poll closure can read the
  // latest tail without re-creating itself on every render.
  const messagesRef = useRef<LobbyChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Auto-scroll to bottom when new messages arrive, but only if the
  // user hasn't scrolled up to read history.
  useEffect(() => {
    if (!stickyBottomRef.current) return;
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickyBottomRef.current = distanceFromBottom < 40;
  }, []);

  const remainingChars = useMemo(() => limits.MAX_LENGTH - draft.length, [limits.MAX_LENGTH, draft.length]);
  const canSend = !sending && draft.trim().length > 0 && draft.length <= limits.MAX_LENGTH;

  const send = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const message = await postLobbyChat({
        userId: profile.userId ?? profile.name,
        name: profile.name,
        text: draft,
      });
      setMessages((prev) => mergeMessages(prev, [message]));
      setDraft('');
      stickyBottomRef.current = true;
    } catch (err) {
      if (err instanceof LobbyChatRateLimitError) {
        setError(err.message);
      } else {
        setError((err as Error).message || 'Failed to send');
      }
    } finally {
      setSending(false);
    }
  }, [canSend, draft, profile.name, profile.userId]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }, [send]);

  return (
    <section className="panel trollbox-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Lobby chat · global</p>
          <h2>💬 Trollbox</h2>
        </div>
        <span className="trollbox-count" title={`${messages.length} messages cached`}>
          {messages.length} msg
        </span>
      </div>
      <div
        className="trollbox-messages"
        ref={listRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {!loaded ? (
          <p className="trollbox-empty">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="trollbox-empty">No messages yet. Be the first to say hi 👋</p>
        ) : (
          messages.map((message) => {
            const isSelf = message.userId === (profile.userId ?? profile.name);
            return (
              <div key={message.id} className={`trollbox-message${isSelf ? ' trollbox-message-self' : ''}`}>
                <div className="trollbox-message-header">
                  <span className="trollbox-message-name">{message.name}{isSelf ? ' (you)' : ''}</span>
                  <span className="trollbox-message-time" title={new Date(message.postedAt).toLocaleString()}>
                    {timeAgo(message.postedAt)}
                  </span>
                </div>
                <p className="trollbox-message-text">{message.text}</p>
              </div>
            );
          })
        )}
      </div>
      <form
        className="trollbox-input-row"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="trollbox-input-wrapper">
          <textarea
            className="trollbox-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Say something to the lobby, ${profile.name}…`}
            maxLength={limits.MAX_LENGTH * 2 /* allow paste; we'll trim on submit */}
            aria-label="Lobby chat message"
            disabled={sending}
            rows={2}
          />
          <span
            className={`trollbox-charcount${remainingChars < 20 ? ' trollbox-charcount-warn' : ''}${remainingChars < 0 ? ' trollbox-charcount-error' : ''}`}
            aria-live="polite"
          >
            {remainingChars}
          </span>
        </div>
        <button
          type="submit"
          className="primary-cta trollbox-send"
          disabled={!canSend}
          aria-label="Send message"
        >
          {sending ? '…' : 'Send ↵'}
        </button>
      </form>
      <div className="trollbox-footer">
        <span className="trollbox-hint">↵ to send · Shift+↵ for newline</span>
        {error && <span className="trollbox-error" role="alert">{error}</span>}
      </div>
    </section>
  );
}
