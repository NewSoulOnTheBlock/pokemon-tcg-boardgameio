// Shared dramatic pack-opening reveal. Used by both DailyPackWidget
// (free daily) and BurnPackPanel ($POKETCG burn). Replaces the tiny
// flip-card grid with a full-bleed ceremony:
//
//   - One big card at a time, centered, click to flip
//   - Slow, anticipation-driven 3D flip animation
//   - Holographic shimmer overlay on uncommon+ cards
//   - Gold burst + screen flash for rare-or-better pulls
//   - Final summary grid + Done button after the last card
//
// Falls back to auto-advance after 2.5s so impatient users can just
// watch. Skip button at top-right always closes immediately.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CARD_LIBRARY } from '../game/cards';

type Tier = 'rare' | 'uncommon' | 'common';

function rarityTier(rarity?: string): Tier {
  if (!rarity) return 'common';
  if (rarity === 'Common') return 'common';
  if (rarity === 'Uncommon') return 'uncommon';
  return 'rare';
}

function safeCard(id: string) {
  try { return CARD_LIBRARY[id]; }
  catch { return undefined; }
}

const AUTO_ADVANCE_MS = 2500;

export function PackOpeningCeremony({
  cardIds,
  title,
  eyebrow,
  onClose,
}: {
  cardIds: string[];
  title: string;
  eyebrow: string;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [showSummary, setShowSummary] = useState(false);

  const cards = useMemo(
    () => cardIds.map((id) => ({ id, card: safeCard(id) })),
    [cardIds],
  );

  // Auto-flip the current card after a short delay if the user hasn't
  // clicked it themselves.
  useEffect(() => {
    if (flipped || showSummary) return;
    const t = window.setTimeout(() => setFlipped(true), AUTO_ADVANCE_MS);
    return () => window.clearTimeout(t);
  }, [flipped, idx, showSummary]);

  // After flip, advance to the next card automatically (or jump to summary).
  useEffect(() => {
    if (!flipped || showSummary) return;
    const t = window.setTimeout(() => {
      if (idx + 1 >= cards.length) {
        setShowSummary(true);
      } else {
        setIdx((n) => n + 1);
        setFlipped(false);
      }
    }, AUTO_ADVANCE_MS);
    return () => window.clearTimeout(t);
  }, [flipped, idx, cards.length, showSummary]);

  const handleCardClick = useCallback(() => {
    if (showSummary) return;
    if (!flipped) {
      setFlipped(true);
    } else if (idx + 1 < cards.length) {
      setIdx((n) => n + 1);
      setFlipped(false);
    } else {
      setShowSummary(true);
    }
  }, [flipped, idx, cards.length, showSummary]);

  const skipToSummary = useCallback(() => setShowSummary(true), []);

  const currentEntry = cards[idx];
  const tier: Tier = currentEntry?.card ? rarityTier(currentEntry.card.rarity) : 'common';
  const rareReveal = flipped && tier === 'rare';

  return (
    <div className="pack-opening-stage" role="dialog" aria-modal="true" aria-label={title}>
      <div className="pack-opening-starfield" aria-hidden="true" />
      <header className="pack-opening-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <button type="button" className="pack-opening-skip" onClick={showSummary ? onClose : skipToSummary}>
          {showSummary ? 'Done' : `Skip → see all ${cards.length}`}
        </button>
      </header>

      {!showSummary ? (
        <>
          <div className="pack-opening-counter">
            Card <strong>{idx + 1}</strong> of {cards.length}
          </div>
          <div className="pack-opening-card-stage" onClick={handleCardClick}>
            {rareReveal && <div className="pack-opening-flash" aria-hidden="true" />}
            {rareReveal && <PackBurst tier={tier} />}
            <article
              className={`pack-opening-card pack-opening-card-${tier}${flipped ? ' pack-opening-card-flipped' : ''}`}
            >
              <div className="pack-opening-card-back" aria-hidden="true">
                <div className="pack-opening-card-back-pattern">
                  <span>⭐</span><span>⭐</span><span>⭐</span><span>⭐</span><span>⭐</span><span>⭐</span>
                </div>
              </div>
              <div className="pack-opening-card-front">
                {currentEntry?.card?.images?.large || currentEntry?.card?.images?.small ? (
                  <img
                    src={currentEntry.card.images.large ?? currentEntry.card.images.small}
                    alt={currentEntry.card.name}
                    draggable={false}
                  />
                ) : (
                  <div className="pack-opening-card-front-text">
                    <strong>{currentEntry?.card?.name ?? '(unknown card)'}</strong>
                    <span>{currentEntry?.card?.rarity ?? 'Common'}</span>
                  </div>
                )}
                {tier !== 'common' && <div className="pack-opening-shine" aria-hidden="true" />}
              </div>
            </article>
          </div>
          <p className="pack-opening-hint">
            {flipped
              ? (idx + 1 < cards.length ? 'Tap or wait for the next card' : 'Tap or wait for summary')
              : 'Tap card to flip'}
          </p>
          <div className="pack-opening-queue" aria-hidden="true">
            {cards.map((_, i) => (
              <span
                key={i}
                className={`pack-opening-queue-dot${i === idx ? ' pack-opening-queue-dot-active' : ''}${i < idx ? ' pack-opening-queue-dot-done' : ''}`}
              />
            ))}
          </div>
        </>
      ) : (
        <PackSummary cards={cards} onClose={onClose} />
      )}
    </div>
  );
}

function PackSummary({
  cards,
  onClose,
}: {
  cards: Array<{ id: string; card: ReturnType<typeof safeCard> }>;
  onClose: () => void;
}) {
  const breakdown = cards.reduce(
    (acc, entry) => {
      const t = entry.card ? rarityTier(entry.card.rarity) : 'common';
      acc[t] += 1;
      return acc;
    },
    { rare: 0, uncommon: 0, common: 0 } as Record<Tier, number>,
  );
  return (
    <>
      <div className="pack-opening-summary-stats">
        <span className="pack-opening-summary-pill pack-opening-summary-pill-rare">{breakdown.rare} rare+</span>
        <span className="pack-opening-summary-pill pack-opening-summary-pill-uncommon">{breakdown.uncommon} uncommon</span>
        <span className="pack-opening-summary-pill pack-opening-summary-pill-common">{breakdown.common} common</span>
      </div>
      <div className="pack-opening-summary-grid">
        {cards.map((entry, i) => {
          const tier: Tier = entry.card ? rarityTier(entry.card.rarity) : 'common';
          return (
            <article
              key={`${entry.id}-${i}`}
              className={`pack-opening-summary-card pack-opening-summary-card-${tier}`}
              title={entry.card ? `${entry.card.name}${entry.card.rarity ? ` — ${entry.card.rarity}` : ''}` : entry.id}
            >
              {entry.card?.images?.small ? (
                <img src={entry.card.images.small} alt={entry.card.name} loading="lazy" />
              ) : (
                <div className="pack-opening-summary-card-text">
                  <strong>{entry.card?.name ?? '(unknown)'}</strong>
                  <span>{entry.card?.rarity ?? 'Common'}</span>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <div className="pack-opening-summary-actions">
        <button className="primary-cta" onClick={onClose} type="button">
          Add to collection
        </button>
      </div>
    </>
  );
}

/** Confetti / sparkle burst behind rare reveals. Pure CSS — 12
 *  positioned spans with staggered animation delays. */
function PackBurst({ tier }: { tier: Tier }) {
  const color = tier === 'rare' ? 'gold' : tier === 'uncommon' ? 'silver' : 'common';
  return (
    <div className={`pack-opening-burst pack-opening-burst-${color}`} aria-hidden="true">
      {Array.from({ length: 12 }).map((_, i) => (
        <span key={i} style={{ '--burst-angle': `${i * 30}deg`, '--burst-delay': `${i * 30}ms` } as React.CSSProperties} />
      ))}
    </div>
  );
}
