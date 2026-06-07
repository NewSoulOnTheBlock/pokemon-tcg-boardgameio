// Daily free Pokemon TCG pack claim. Lives on the Home page as the
// canonical free-pack entry point — once per ~22 hours, server-roll
// of a random booster set, added to the user's ownedCards (no on-chain
// mint, no payment).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { addCardsToCollection, type ProfileState, type PackPurchase } from '../shared/profile';
import { claimFreeBooster, DailyClaimError, persistPackPurchase, type FreeBoosterResult } from '../api/profiles';

const STORAGE_KEY_PREFIX = 'free_pack_last_claim_';
const COOLDOWN_MS = 22 * 60 * 60 * 1000;

function lastClaimKey(profile: ProfileState): string {
  return `${STORAGE_KEY_PREFIX}${profile.userId ?? profile.wallet?.address ?? profile.name}`;
}

function readLastClaim(profile: ProfileState): number | null {
  try {
    const raw = window.localStorage.getItem(lastClaimKey(profile));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeLastClaim(profile: ProfileState, ts: number): void {
  try {
    window.localStorage.setItem(lastClaimKey(profile), String(ts));
  } catch {
    /* ignore */
  }
}

function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function DailyFreePack({
  profile,
  onProfileChange,
}: {
  profile: ProfileState;
  onProfileChange: (profile: ProfileState) => void;
}) {
  const [lastClaim, setLastClaim] = useState<number | null>(() => readLastClaim(profile));
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<FreeBoosterResult | null>(null);

  useEffect(() => {
    if (!lastClaim) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [lastClaim]);

  const remainingMs = useMemo(() => {
    if (!lastClaim) return 0;
    return Math.max(0, COOLDOWN_MS - (now - lastClaim));
  }, [lastClaim, now]);

  const canClaim = remainingMs <= 0 && !busy;

  const claim = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await claimFreeBooster({
        userId: profile.userId,
        walletAddress: profile.wallet?.address,
        source: 'daily',
      });
      setReveal(result);

      const cardIds = result.pack.map((entry) => entry.card.id);
      const purchase: PackPurchase = {
        signature: `free-${result.claimedAt}`,
        openedAt: result.claimedAt,
        cardIds,
      };
      const updated: ProfileState = {
        ...profile,
        ownedCards: addCardsToCollection(profile.ownedCards, cardIds),
        packsOpened: profile.packsOpened + 1,
        packPurchases: [...profile.packPurchases, purchase],
      };
      const saved = await persistPackPurchase(updated, purchase);
      onProfileChange(saved);

      const claimedAt = Date.parse(result.claimedAt) || Date.now();
      writeLastClaim(profile, claimedAt);
      setLastClaim(claimedAt);
    } catch (err) {
      if (err instanceof DailyClaimError) {
        const ts = Date.now() - (COOLDOWN_MS - err.retryAfterMs);
        writeLastClaim(profile, ts);
        setLastClaim(ts);
        setError(`Daily pack already claimed. Next pack in ${formatCountdown(err.retryAfterMs)}.`);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }, [onProfileChange, profile]);

  return (
    <section className="panel daily-pack-panel">
      <div className="daily-pack-header">
        <div>
          <p className="eyebrow">Daily reward</p>
          <h2>🎁 Free Pokémon TCG Pack</h2>
          <p className="daily-pack-sub">
            One free booster every 22 hours. Cards go straight into your collection — ready to deckbuild.
          </p>
        </div>
        <button
          className="primary-cta daily-pack-cta"
          onClick={() => void claim()}
          disabled={!canClaim}
        >
          {busy
            ? 'Claiming…'
            : canClaim
              ? 'Claim free pack'
              : `Next pack in ${formatCountdown(remainingMs)}`}
        </button>
      </div>
      {error && <p className="error daily-pack-error">{error}</p>}
      {reveal && <FreePackReveal result={reveal} onDismiss={() => setReveal(null)} />}
    </section>
  );
}

function FreePackReveal({ result, onDismiss }: { result: FreeBoosterResult; onDismiss: () => void }) {
  return (
    <div className="daily-pack-reveal">
      <div className="daily-pack-reveal-header">
        <strong>You pulled from {result.set.name}</strong>
        <button onClick={onDismiss}>Close</button>
      </div>
      <div className="daily-pack-reveal-grid">
        {result.pack.map((entry, index) => (
          <article key={`${entry.card.id}-${index}`} className={`daily-pack-card daily-pack-card-${entry.slot.toLowerCase()}`}>
            {entry.card.images?.small && (
              <img src={entry.card.images.small} alt={entry.card.name} loading="lazy" />
            )}
            <strong>{entry.card.name}</strong>
            <span>{entry.slot}{entry.card.rarity ? ` · ${entry.card.rarity}` : ''}</span>
          </article>
        ))}
      </div>
    </div>
  );
}
