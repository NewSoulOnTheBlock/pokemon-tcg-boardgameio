import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerID } from '../game/types';

interface ChatMessageRaw {
  id: string;
  sender: string;
  payload: unknown;
}

interface ChatMessageDisplay {
  id: string;
  sender: PlayerID;
  text: string;
  senderName?: string;
}

const MAX_MESSAGE_LENGTH = 200;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normaliseMessage(raw: ChatMessageRaw): ChatMessageDisplay | undefined {
  const sender = raw.sender === '0' || raw.sender === '1' ? (raw.sender as PlayerID) : undefined;
  if (!sender) return undefined;
  let text: string | undefined;
  let senderName: string | undefined;
  if (typeof raw.payload === 'string') {
    text = raw.payload;
  } else if (raw.payload && typeof raw.payload === 'object') {
    text = asString((raw.payload as Record<string, unknown>).text);
    senderName = asString((raw.payload as Record<string, unknown>).senderName);
  }
  if (!text) return undefined;
  return { id: raw.id, sender, text, senderName };
}

/**
 * Floating chat panel for multiplayer matches. Uses boardgame.io's
 * built-in chat channel (``chatMessages`` + ``sendChatMessage`` props
 * surfaced by the React Client) so messages flow through the same
 * Socket.IO transport as game moves — no extra infra. Hidden entirely
 * when ``sendChatMessage`` is unavailable (Local / bot match).
 */
export function MatchChatPanel({
  chatMessages = [],
  sendChatMessage,
  selfPlayerID,
  selfName,
  opponentName,
}: {
  chatMessages?: ChatMessageRaw[];
  sendChatMessage?: (payload: unknown) => void;
  selfPlayerID: PlayerID;
  selfName?: string;
  opponentName?: string;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const lastSeenIdRef = useRef<string | null>(null);

  const messages = useMemo<ChatMessageDisplay[]>(
    () => chatMessages.map(normaliseMessage).filter((m): m is ChatMessageDisplay => Boolean(m)),
    [chatMessages],
  );

  // Auto-scroll on every new message when the panel is open.
  useEffect(() => {
    if (!collapsed && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length, collapsed]);

  // Track unread counter when collapsed; opening the panel clears it.
  useEffect(() => {
    if (collapsed) {
      const fromOpponent = messages.filter((m) => m.sender !== selfPlayerID);
      const lastId = lastSeenIdRef.current;
      if (!lastId) {
        // Initial mount — treat all current messages as already seen.
        lastSeenIdRef.current = messages.at(-1)?.id ?? null;
        setUnread(0);
        return;
      }
      const lastSeenIndex = fromOpponent.findIndex((m) => m.id === lastId);
      const after = lastSeenIndex === -1 ? fromOpponent : fromOpponent.slice(lastSeenIndex + 1);
      setUnread(after.length);
    } else {
      lastSeenIdRef.current = messages.at(-1)?.id ?? lastSeenIdRef.current;
      setUnread(0);
    }
  }, [collapsed, messages, selfPlayerID]);

  if (!sendChatMessage) return null;

  function submit() {
    const text = draft.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!text || !sendChatMessage) return;
    sendChatMessage({ text, senderName: selfName });
    setDraft('');
  }

  return (
    <div className={`match-chat-panel${collapsed ? ' match-chat-panel-collapsed' : ''}`}>
      <button
        type="button"
        className="match-chat-toggle"
        aria-label={collapsed ? 'Open chat' : 'Close chat'}
        onClick={() => setCollapsed((current) => !current)}
      >
        💬 Chat
        {collapsed && unread > 0 && (
          <span className="match-chat-unread" aria-label={`${unread} unread`}>{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {!collapsed && (
        <>
          <div className="match-chat-list" ref={listRef}>
            {messages.length === 0 ? (
              <p className="match-chat-empty">No messages yet — say hi to {opponentName ?? 'your opponent'}.</p>
            ) : (
              messages.map((message) => {
                const isSelf = message.sender === selfPlayerID;
                const label = isSelf
                  ? selfName ?? 'You'
                  : message.senderName ?? opponentName ?? `Player ${message.sender}`;
                return (
                  <div
                    key={message.id}
                    className={`match-chat-message${isSelf ? ' match-chat-message-self' : ''}`}
                  >
                    <span className="match-chat-author">{label}</span>
                    <span className="match-chat-text">{message.text}</span>
                  </div>
                );
              })
            )}
          </div>
          <form
            className="match-chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <input
              type="text"
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder="Type a message..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" disabled={!draft.trim()}>Send</button>
          </form>
        </>
      )}
    </div>
  );
}
