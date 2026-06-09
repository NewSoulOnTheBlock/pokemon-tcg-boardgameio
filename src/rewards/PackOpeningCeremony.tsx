// Shared dramatic pack-opening reveal. Used by both DailyPackWidget
// (free daily) and BurnPackPanel ($POKETCG burn). Full-screen takeover:
//
//   - HUGE single card center stage (uses up to 85vh tall)
//   - Click to flip → click again to advance (NO auto-timers)
//   - Holographic shimmer on uncommon+ cards
//   - Gold burst + screen flash on rare reveal
//   - Summary grid at the end with hover-preview that pops out a
//     large card image when the user hovers any thumbnail.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
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

  const handleCardClick = useCallback(() => {
    if (showSummary) return;
    if (!flipped) {
      // First click: flip the current card open.
      setFlipped(true);
    } else if (idx + 1 < cards.length) {
      // Second click: advance to the next card.
      setIdx((n) => n + 1);
      setFlipped(false);
    } else {
      // Last card already flipped: jump to summary.
      setShowSummary(true);
    }
  }, [flipped, idx, cards.length, showSummary]);

  const skipToSummary = useCallback(() => setShowSummary(true), []);

  // Lock background scroll while the ceremony is open so the page
  // can't peek through above/below the modal.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const currentEntry = cards[idx];
  const tier: Tier = currentEntry?.card ? rarityTier(currentEntry.card.rarity) : 'common';
  const rareReveal = flipped && tier === 'rare';

  // CRITICAL: portal to document.body. Several parent panels use
  // `backdrop-filter: blur(...)` (e.g. `.home-sidebar`, profile
  // panels) which per CSS spec creates a containing block for any
  // `position: fixed` descendant — anchoring `inset: 0` to the
  // panel's 460px column instead of the viewport. The portal lifts
  // the modal out of every such ancestor so it covers the full screen.
  const content = (
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
          <div
            className="pack-opening-card-stage"
            onClick={handleCardClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardClick(); } }}
          >
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
          <p className="pack-opening-hint pack-opening-hint-pulse">
            {!flipped
              ? '👆 Click the card to flip it'
              : idx + 1 < cards.length
                ? '👆 Click again for the next card'
                : '👆 Click again to see your full pull'}
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

  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
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
      <p className="pack-opening-summary-hint">Hover any card to enlarge it</p>
      <div className="pack-opening-summary-grid">
        {cards.map((entry, i) => {
          const tier: Tier = entry.card ? rarityTier(entry.card.rarity) : 'common';
          const imgLarge = entry.card?.images?.large ?? entry.card?.images?.small;
          return (
            <article
              key={`${entry.id}-${i}`}
              className={`pack-opening-summary-card pack-opening-summary-card-${tier}`}
              tabIndex={0}
            >
              {entry.card?.images?.small ? (
                <img src={entry.card.images.small} alt={entry.card.name} loading="lazy" />
              ) : (
                <div className="pack-opening-summary-card-text">
                  <strong>{entry.card?.name ?? '(unknown)'}</strong>
                  <span>{entry.card?.rarity ?? 'Common'}</span>
                </div>
              )}
              {imgLarge && (
                <div className="pack-opening-summary-hover" aria-hidden="true">
                  <img src={imgLarge} alt="" />
                  <div className="pack-opening-summary-hover-meta">
                    <strong>{entry.card?.name ?? '(unknown)'}</strong>
                    <span>{entry.card?.rarity ?? 'Common'}</span>
                  </div>
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

function PackBurst({ tier }: { tier: Tier }) {
  const color = tier === 'rare' ? 'gold' : tier === 'uncommon' ? 'silver' : 'common';
  return (
    <div className={`pack-opening-burst pack-opening-burst-${color}`} aria-hidden="true">
      {Array.from({ length: 16 }).map((_, i) => (
        <span key={i} style={{ '--burst-angle': `${i * 22.5}deg`, '--burst-delay': `${i * 20}ms` } as React.CSSProperties} />
      ))}
    </div>
  );
}

