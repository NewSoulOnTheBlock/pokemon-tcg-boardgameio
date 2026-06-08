// $POKETCG burn-to-buy-pack panel. Renders below the deckbuilder on the
// profile page. Lets the connected wallet burn 250,000 $POKETCG per
// playable booster pack (5C + 3U + 1R) — tokens are permanently
// destroyed, no treasury, no transfer.

import { useCallback, useEffect, useState } from 'react';
import { CARD_LIBRARY } from '../game/cards';
import type { ProfileState, StoredProfile } from '../shared/profile';
import { redeemBurnPack } from '../api/rewards';
import {
  POKETCG_PACK_TIERS,
  burnPoketcgForPacks,
  fetchPoketcgBalance,
  findPoketcgTier,
} from './burnTokens';

const PACK_OPTIONS = POKETCG_PACK_TIERS;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return Math.round(n).toString();
}

function rarityBucket(rarity?: string): 'rare' | 'uncommon' | 'common' {
  if (!rarity) return 'common';
  if (rarity === 'Common') return 'common';
  if (rarity === 'Uncommon') return 'uncommon';
  return 'rare';
}

export function BurnPackPanel({
  profile,
  onProfileChange,
}: {
  profile: ProfileState;
  onProfileChange: (profile: ProfileState) => void;
}) {
  const wallet = profile.wallet;
  const [packCount, setPackCount] = useState<number>(1);
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState<'sign' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [revealCards, setRevealCards] = useState<string[] | null>(null);

  const refreshBalance = useCallback(async () => {
    if (!wallet?.address) {
      setBalance(null);
      return;
    }
    try {
      const next = await fetchPoketcgBalance(wallet.address);
      setBalance(next);
    } catch {
      setBalance(null);
    }
  }, [wallet?.address]);

  useEffect(() => { void refreshBalance(); }, [refreshBalance]);

  const totalCost = findPoketcgTier(packCount)?.costTokens ?? 0;
  const insufficient = balance !== null && balance < totalCost;
  const canBuy = !!profile.userId && !!wallet?.address && wallet.chain === 'solana';

  const handleBurn = useCallback(async () => {
    if (!profile.userId || !wallet?.address || wallet.chain !== 'solana') {
      setError('Connect a Solana wallet first.');
      return;
    }
    setError(null);
    setInfo(null);
    try {
      setBusy('sign');
      const signature = await burnPoketcgForPacks({
        buyerWallet: wallet.address,
        packs: packCount,
      });
      setBusy('verify');
      const result = await redeemBurnPack({
        profile,
        signature,
        buyerWallet: wallet.address,
        packs: packCount,
      });
      onProfileChange({
        ...profile,
        ...(result.profile as StoredProfile),
      });
      setRevealCards(result.purchase.cardIds);
      setInfo(
        result.alreadyRedeemed
          ? `That burn was already redeemed — re-showing the same ${result.purchase.cardIds.length} cards.`
          : `Burned ${formatTokens(totalCost)} $POKETCG. ${result.purchase.cardIds.length} cards added.`,
      );
      await refreshBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Burn failed');
    } finally {
      setBusy(null);
    }
  }, [onProfileChange, packCount, profile, refreshBalance, totalCost, wallet?.address, wallet?.chain]);

  return (
    <section className="panel burn-pack-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Booster Shop · $POKETCG burn</p>
          <h2>Buy Playable Packs</h2>
          <p className="section-subtitle">
            Each pack: 5 commons + 3 uncommons + 1 rare-or-better. Cheapest tier:{' '}
            <strong>{formatTokens(POKETCG_PACK_TIERS[0]!.costTokens)} $POKETCG</strong>{' '}
            for 1 pack — bulk tiers below are discounted. Tokens are permanently burned.
          </p>
        </div>
        <div className="burn-pack-balance">
          <span className="burn-pack-balance-label">Your balance</span>
          <strong>{balance === null ? '—' : `${formatTokens(balance)} $POKETCG`}</strong>
          <button type="button" className="burn-pack-refresh" onClick={() => void refreshBalance()}>↻</button>
        </div>
      </div>

      <div className="burn-pack-options">
        {PACK_OPTIONS.map((tier) => {
          const perPack = tier.costTokens / tier.packs;
          const cheapestPerPack = POKETCG_PACK_TIERS[0]!.costTokens / POKETCG_PACK_TIERS[0]!.packs;
          const discountPct = Math.round((1 - perPack / cheapestPerPack) * 100);
          return (
            <button
              key={tier.packs}
              type="button"
              className={`burn-pack-option${packCount === tier.packs ? ' burn-pack-option-active' : ''}`}
              onClick={() => setPackCount(tier.packs)}
            >
              <strong>{tier.packs} pack{tier.packs === 1 ? '' : 's'}</strong>
              <span>{formatTokens(tier.costTokens)} $POKETCG</span>
              {discountPct > 0 && (
                <span className="burn-pack-option-discount">SAVE {discountPct}%</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="burn-pack-actions">
        <button
          type="button"
          className="primary-cta burn-pack-buy"
          onClick={handleBurn}
          disabled={!canBuy || busy !== null || insufficient}
        >
          {!canBuy
            ? 'Connect Solana wallet'
            : busy === 'sign'
              ? 'Approve burn in wallet…'
              : busy === 'verify'
                ? 'Verifying burn…'
                : insufficient
                  ? `Need ${formatTokens(totalCost - (balance ?? 0))} more $POKETCG`
                  : `Burn ${formatTokens(totalCost)} $POKETCG → ${packCount} pack${packCount === 1 ? '' : 's'}`}
        </button>
        <p className="burn-pack-disclaimer">
          ⚠ Tokens are permanently destroyed. Cards added to your collection. Make sure you have at least 0.001 SOL for tx fees.
        </p>
      </div>

      {info && <p className="success burn-pack-info">{info}</p>}
      {error && <p className="error burn-pack-error">{error}</p>}

      {revealCards && (
        <BurnPackRevealModal cardIds={revealCards} onClose={() => setRevealCards(null)} />
      )}
    </section>
  );
}

function BurnPackRevealModal({
  cardIds,
  onClose,
}: {
  cardIds: string[];
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    if (revealed >= cardIds.length) return;
    const timer = window.setTimeout(() => setRevealed((n) => n + 1), 180);
    return () => window.clearTimeout(timer);
  }, [revealed, cardIds.length]);

  const cards = cardIds.map((id) => {
    try { return CARD_LIBRARY[id]; } catch { return undefined; }
  });

  return (
    <div className="wager-modal-backdrop" role="dialog" aria-modal="true" aria-label="Pack opened">
      <div className="wager-modal daily-pack-reveal">
        <p className="eyebrow">$POKETCG BURN</p>
        <h2>Pack opened — {cardIds.length} cards</h2>
        <p className="wager-modal-sub">Cards added to your collection.</p>
        <div className="daily-pack-reveal-grid">
          {cards.map((card, i) => {
            const tier = card ? rarityBucket(card.rarity) : 'common';
            const flipped = i < revealed;
            return (
              <div
                key={`${card?.id ?? '?'}-${i}`}
                className={`daily-pack-card daily-pack-card-${tier}${flipped ? ' daily-pack-card-revealed' : ''}`}
                title={card ? `${card.name}${card.rarity ? ` — ${card.rarity}` : ''}` : '(unknown)'}
              >
                <div className="daily-pack-card-back" aria-hidden="true">⭐</div>
                <div className="daily-pack-card-front">
                  {card?.images?.small ? (
                    <img src={card.images.small} alt={card.name} loading="lazy" />
                  ) : (
                    <div className="daily-pack-card-text">
                      <strong>{card?.name ?? '(unknown)'}</strong>
                      <span>{card?.rarity ?? 'Common'}</span>
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
