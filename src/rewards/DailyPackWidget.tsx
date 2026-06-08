// Daily-free-pack home-page widget. Shows either:
//   * a "Claim daily pack" button when the user is off cooldown, OR
//   * a countdown to next claim when on cooldown.
// On claim, opens a modal with a reveal animation that flips each
// rolled card face-up sequentially.

import { useCallback, useEffect, useState } from 'react';
import { CARD_LIBRARY } from '../game/cards';
import type { ProfileState, StoredProfile } from '../shared/profile';
import {
  claimDailyPack as apiClaimDailyPack,
  fetchDailyPackStatus,
  RewardCooldownError,
  type DailyPackStatus,
} from '../api/rewards';

const TICK_INTERVAL_MS = 1000;

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function rarityBucket(rarity?: string): 'rare' | 'uncommon' | 'common' {
  if (!rarity) return 'common';
  if (rarity === 'Common') return 'common';
  if (rarity === 'Uncommon') return 'uncommon';
  return 'rare';
}

export function DailyPackWidget({
  profile,
  onProfileChange,
}: {
  profile: ProfileState;
  onProfileChange: (profile: ProfileState) => void;
}) {
  const [status, setStatus] = useState<DailyPackStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealCards, setRevealCards] = useState<string[] | null>(null);

  // Initial status fetch + refresh whenever the user logs in/out.
  useEffect(() => {
    let cancelled = false;
    if (!profile.userId) {
      setStatus(null);
      return () => { cancelled = true; };
    }
    fetchDailyPackStatus(profile)
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [profile.userId]);

  // Live tick the countdown.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  const nextAtMs = status?.nextClaimAt ? Date.parse(status.nextClaimAt) : 0;
  const remainingMs = Math.max(0, nextAtMs - now);
  const ready = !status?.lastClaimAt || remainingMs === 0;

  const handleClaim = useCallback(async () => {
    if (!profile.userId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiClaimDailyPack(profile);
      onProfileChange({
        ...profile,
        ...(result.profile as StoredProfile),
      });
      setStatus({
        lastClaimAt: result.profile.lastDailyPackAt ?? null,
        nextClaimAt: result.nextClaimAt,
        canClaim: false,
        cooldownMs: status?.cooldownMs ?? 22 * 60 * 60 * 1000,
      });
      setRevealCards(result.purchase.cardIds);
    } catch (err) {
      if (err instanceof RewardCooldownError) {
        setStatus((prev) => prev ? {
          ...prev,
          nextClaimAt: err.nextClaimAt,
          canClaim: false,
        } : prev);
        setError('Already claimed today. Come back later!');
      } else {
        setError(err instanceof Error ? err.message : 'Claim failed');
      }
    } finally {
      setBusy(false);
    }
  }, [profile, onProfileChange, status]);

  if (!profile.userId) return null;

  return (
    <>
      <article className={`daily-pack-widget${ready ? ' daily-pack-ready' : ' daily-pack-locked'}`}>
        <div className="daily-pack-icon" aria-hidden="true">{ready ? '🎴' : '⏳'}</div>
        <div className="daily-pack-body">
          <strong>Daily Free Pack</strong>
          {ready ? (
            <p>5 commons + 3 uncommons + 1 rare-or-better. Free, every day.</p>
          ) : (
            <p>Next pack in <span className="daily-pack-countdown">{formatCountdown(remainingMs)}</span></p>
          )}
          {error && <p className="daily-pack-error">{error}</p>}
        </div>
        <button
          className="daily-pack-claim"
          disabled={!ready || busy}
          onClick={handleClaim}
          type="button"
        >
          {busy ? 'Opening…' : ready ? 'Claim' : 'Locked'}
        </button>
      </article>
      {revealCards && (
        <DailyPackRevealModal
          cardIds={revealCards}
          onClose={() => setRevealCards(null)}
        />
      )}
    </>
  );
}

function DailyPackRevealModal({
  cardIds,
  onClose,
}: {
  cardIds: string[];
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(0);
  // Auto-reveal: flip one card every 220ms until they're all face-up.
  useEffect(() => {
    if (revealed >= cardIds.length) return;
    const timer = window.setTimeout(() => setRevealed((n) => n + 1), 220);
    return () => window.clearTimeout(timer);
  }, [revealed, cardIds.length]);

  const cards = cardIds.map((id) => {
    try {
      return CARD_LIBRARY[id];
    } catch {
      return undefined;
    }
  });

  return (
    <div className="wager-modal-backdrop" role="dialog" aria-modal="true" aria-label="Daily pack opened">
      <div className="wager-modal daily-pack-reveal">
        <p className="eyebrow">DAILY PACK</p>
        <h2>Today's Pull</h2>
        <p className="wager-modal-sub">Cards added to your collection.</p>
        <div className="daily-pack-reveal-grid">
          {cards.map((card, i) => {
            if (!card) {
              return (
                <div key={i} className={`daily-pack-card daily-pack-card-common${i < revealed ? ' daily-pack-card-revealed' : ''}`}>
                  <div className="daily-pack-card-back" aria-hidden="true">?</div>
                  <div className="daily-pack-card-front">
                    <strong>(unknown)</strong>
                  </div>
                </div>
              );
            }
            const tier = rarityBucket(card.rarity);
            const flipped = i < revealed;
            return (
              <div
                key={`${card.id}-${i}`}
                className={`daily-pack-card daily-pack-card-${tier}${flipped ? ' daily-pack-card-revealed' : ''}`}
                title={`${card.name}${card.rarity ? ` — ${card.rarity}` : ''}`}
              >
                <div className="daily-pack-card-back" aria-hidden="true">⭐</div>
                <div className="daily-pack-card-front">
                  {card.images?.small ? (
                    <img src={card.images.small} alt={card.name} loading="lazy" />
                  ) : (
                    <div className="daily-pack-card-text">
                      <strong>{card.name}</strong>
                      <span>{card.rarity ?? 'Common'}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="wager-modal-actions">
          <button className="primary-cta" onClick={onClose} type="button">
            {revealed >= cardIds.length ? 'Done' : `Skip (${revealed}/${cardIds.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
