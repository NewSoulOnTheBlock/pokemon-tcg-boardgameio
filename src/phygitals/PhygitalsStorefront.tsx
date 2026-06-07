// Phygitals storefront UI — paid real-physical-card flow.
//
// Surface (Jun 2026):
//   - Shop tab: browse packs from /api/vm/available, buy with USDC/USDT
//     via wallet signing.
//   - My Pulls tab: client-only history of items the user has pulled,
//     cached per-wallet in localStorage. The Phygitals API no longer
//     exposes an inventory endpoint, so the only authoritative record
//     of what a user owns is what we cached at buy time.
//   - Sellback: per-item button that runs the take-claw-bid init →
//     wallet sign → finish flow.
//
// Shipping is no longer supported by the Phygitals API surface and has
// been removed from the UI.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchPhygitalsPacks,
  fetchPhygitalsStatus,
  finishPhygitalsSellback,
  initPhygitalsSellback,
  preparePhygitalsBuy,
  submitPhygitalsBuy,
  PhygitalsApiError,
  type PhygitalsPack,
  type PhygitalsPullItem,
} from '../api/phygitals';
import {
  signManyVersionedTransactions,
  signVersionedTransactionBase64,
} from '../walletPayment';
import type { ProfileState } from '../shared/profile';

// ============================================================================
// Local "My Pulls" store
// ============================================================================

const PULLS_STORAGE_PREFIX = 'phygitals_pulls_';

interface StoredPull extends PhygitalsPullItem {
  /** Timestamp of when the pull was recorded locally. */
  recordedAt: string;
  /** Set to true when the user has sold this item back. */
  soldBack?: boolean;
  /** USD amount received from the sellback, when soldBack=true. */
  soldBackAmount?: number;
}

function pullsKey(profile: ProfileState): string {
  return `${PULLS_STORAGE_PREFIX}${profile.userId ?? profile.wallet?.address ?? profile.name}`;
}

function loadPulls(profile: ProfileState): StoredPull[] {
  try {
    const raw = window.localStorage.getItem(pullsKey(profile));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePulls(profile: ProfileState, pulls: StoredPull[]): void {
  try {
    window.localStorage.setItem(pullsKey(profile), JSON.stringify(pulls));
  } catch {
    /* ignore quota errors */
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatUsd(n: number | undefined): string {
  if (!Number.isFinite(n)) return '—';
  const v = Number(n);
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ============================================================================
// Shared atoms
// ============================================================================

function PhygitalsStatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={`phygitals-status-badge${enabled ? ' phygitals-status-badge-live' : ' phygitals-status-badge-off'}`}>
      {enabled ? 'LIVE' : 'NOT CONFIGURED'}
    </span>
  );
}

function RarityChip({ tier }: { tier: NonNullable<PhygitalsPack['rarity_distribution']>[number] }) {
  return (
    <span className="phy-rarity-chip" style={{ borderColor: tier.color ?? undefined, color: tier.color ?? undefined }}>
      <strong>{tier.name}</strong>
      <span>{tier.weight ?? '?'}%</span>
    </span>
  );
}

// ============================================================================
// Hero
// ============================================================================

export function PhygitalsHero({ profile }: { profile: ProfileState }) {
  const [status, setStatus] = useState<{ enabled: boolean; baseUrl: string } | null>(null);
  useEffect(() => {
    fetchPhygitalsStatus().then(setStatus).catch(() => setStatus({ enabled: false, baseUrl: '' }));
  }, []);

  return (
    <section className="panel phygitals-hero">
      <div className="phygitals-hero-text">
        <p className="eyebrow">
          Powered by Phygitals {status && <PhygitalsStatusBadge enabled={status.enabled} />}
        </p>
        <h1>Real cards. Real liquidity. Buy with USDC.</h1>
        <p>
          Every pack is backed by a graded physical card held in an insured US vault.
          Pay with USDC/USDT in your Solana wallet, reveal instantly, hold or sell back
          to Phygitals' marketplace for liquidity.
        </p>
        <p className="phygitals-hero-meta">
          Signed in as <strong>{profile.name}</strong>
          {profile.wallet?.address ? <> · wallet <code>{profile.wallet.address.slice(0, 4)}…{profile.wallet.address.slice(-4)}</code></> : null}
        </p>
      </div>
    </section>
  );
}

// ============================================================================
// Shop tab — pack catalog
// ============================================================================

export function PhygitalsShopTab({ profile, onPurchased }: {
  profile: ProfileState;
  onPurchased: (items: PhygitalsPullItem[]) => void;
}) {
  const [packs, setPacks] = useState<PhygitalsPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePack, setActivePack] = useState<PhygitalsPack | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPhygitalsPacks()
      .then((rows) => { if (!cancelled) setPacks(rows); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(
    () => packs.filter((pack) => pack.enable !== false),
    [packs],
  );

  if (loading) return <div className="panel"><p className="empty-state">Loading Phygitals catalog…</p></div>;
  if (error) return <div className="panel"><p className="error">Phygitals: {error}</p></div>;
  if (visible.length === 0) {
    return (
      <div className="panel">
        <p className="empty-state">No Phygitals packs available right now. Check back soon.</p>
      </div>
    );
  }

  return (
    <>
      <div className="phygitals-grid">
        {visible.map((pack) => (
          <PhygitalsPackCard key={pack.id} pack={pack} onOpen={() => setActivePack(pack)} />
        ))}
      </div>
      {activePack && (
        <PhygitalsPackDetailModal
          pack={activePack}
          profile={profile}
          onClose={() => setActivePack(null)}
          onPurchased={onPurchased}
        />
      )}
    </>
  );
}

function PhygitalsPackCard({ pack, onOpen }: { pack: PhygitalsPack; onOpen: () => void }) {
  const soldOut = pack.in_stock === false;
  return (
    <article className={`phygitals-pack-card${soldOut ? ' phygitals-pack-card-soldout' : ''}`}>
      {pack.claw_image_url ? (
        <div className="phygitals-pack-art">
          <img src={pack.claw_image_url} alt={pack.name ?? pack.slug} loading="lazy" />
        </div>
      ) : null}
      <div className="phygitals-pack-body">
        <header className="phygitals-pack-header">
          <h3>{pack.name ?? pack.slug}</h3>
          {pack.type && <span className="phygitals-pack-type">{pack.type}</span>}
        </header>
        {pack.categories && pack.categories.length > 0 && (
          <p className="phygitals-pack-categories">{pack.categories.join(' · ')}</p>
        )}
        <div className="phygitals-pack-pricing">
          <div className="phygitals-pack-price">
            <span className="label">Per pull</span>
            <strong>{formatUsd(pack.mint_price)}</strong>
          </div>
          <div className="phygitals-pack-price">
            <span className="label">EV</span>
            <strong>{formatUsd(pack.ev)}</strong>
          </div>
          <div className="phygitals-pack-price">
            <span className="label">Buyback</span>
            <strong>{pack.buyback_percent ? `${Math.round(pack.buyback_percent * 100)}%` : '—'}</strong>
          </div>
        </div>
        {pack.rarity_distribution && pack.rarity_distribution.length > 0 && (
          <div className="phygitals-rarity-row">
            {pack.rarity_distribution.map((tier) => <RarityChip key={tier.id} tier={tier} />)}
          </div>
        )}
        {pack.num_pulls_7d ? (
          <p className="phygitals-pack-meta">🔥 {pack.num_pulls_7d.toLocaleString()} pulls last 7d</p>
        ) : null}
        <button
          className="primary-cta phygitals-buy-cta"
          onClick={onOpen}
          disabled={soldOut}
        >
          {soldOut ? 'Sold out' : 'View pack'}
        </button>
      </div>
    </article>
  );
}

function PhygitalsPackDetailModal({ pack, profile, onClose, onPurchased }: {
  pack: PhygitalsPack;
  profile: ProfileState;
  onClose: () => void;
  onPurchased: (items: PhygitalsPullItem[]) => void;
}) {
  const [amount, setAmount] = useState(1);
  const [currency, setCurrency] = useState<'usdc' | 'usdt'>('usdc');
  const [busy, setBusy] = useState<'prepare' | 'sign' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulled, setPulled] = useState<PhygitalsPullItem[] | null>(null);
  const maxAmount = Math.max(1, pack.max_per_mint ?? 10);
  const totalCost = (pack.mint_price ?? 0) * amount;
  const buyerWallet = profile.wallet?.address;

  const handleBuy = useCallback(async () => {
    if (!buyerWallet) {
      setError('Connect a Solana wallet first to buy a Phygitals pack.');
      return;
    }
    setError(null);
    try {
      setBusy('prepare');
      const prepared = await preparePhygitalsBuy({
        buyerWallet,
        packId: pack.id,
        amount,
        currency,
      });

      setBusy('sign');
      const signedTxBytes = await signVersionedTransactionBase64({
        payerAddress: buyerWallet,
        transactionBase64: prepared.transactionBase64,
      });

      setBusy('submit');
      const result = await submitPhygitalsBuy({
        packId: prepared.packId,
        amount: prepared.amount,
        currency: prepared.currency,
        signedTxBytes,
      });

      setPulled(result.nfts ?? []);
      onPurchased(result.nfts ?? []);
    } catch (err) {
      setError(err instanceof PhygitalsApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [amount, buyerWallet, currency, onPurchased, pack.id]);

  return (
    <div className="phygitals-modal-backdrop" onClick={onClose}>
      <div className="phygitals-modal" onClick={(event) => event.stopPropagation()}>
        <header className="phygitals-modal-header">
          <h2>{pack.name ?? pack.slug}</h2>
          <button className="phygitals-modal-close" aria-label="Close" onClick={onClose}>✕</button>
        </header>

        {pack.description && <p className="phygitals-pack-description">{pack.description}</p>}

        {pack.chase && pack.chase.length > 0 && (
          <section className="phygitals-modal-section">
            <h3>Chase cards</h3>
            <div className="phygitals-chase-strip">
              {pack.chase.slice(0, 8).map((card) => (
                <div className="phygitals-chase-card" key={card.id}>
                  {card.image && <img src={card.image} alt={card.name} loading="lazy" />}
                  <p>{card.name}</p>
                  <span>{formatUsd(card.fmv)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {!pulled ? (
          <section className="phygitals-modal-section">
            <div className="phygitals-purchase-row">
              <label>
                Pulls
                <input
                  type="number"
                  min={1}
                  max={maxAmount}
                  value={amount}
                  onChange={(event) => {
                    const next = Math.max(1, Math.min(maxAmount, Math.floor(Number(event.target.value) || 1)));
                    setAmount(next);
                  }}
                />
                <span className="phygitals-purchase-cap">max {maxAmount}</span>
              </label>
              <label>
                Pay with
                <select value={currency} onChange={(event) => setCurrency(event.target.value as 'usdc' | 'usdt')}>
                  <option value="usdc">USDC</option>
                  <option value="usdt">USDT</option>
                </select>
              </label>
              <div className="phygitals-purchase-total">
                <span className="label">Total</span>
                <strong>{formatUsd(totalCost)}</strong>
              </div>
              <button className="primary-cta" onClick={handleBuy} disabled={busy !== null || !buyerWallet || pack.in_stock === false}>
                {!buyerWallet
                  ? 'Connect wallet'
                  : busy === 'prepare'
                    ? 'Preparing tx…'
                    : busy === 'sign'
                      ? 'Approve in wallet…'
                      : busy === 'submit'
                        ? 'Submitting…'
                        : `Buy ${amount} pull${amount === 1 ? '' : 's'}`}
              </button>
            </div>
            {error && <p className="error">{error}</p>}
            <p className="phygitals-purchase-note">
              Your wallet pays {formatUsd(totalCost)} {currency.toUpperCase()} directly to Phygitals.
              Phygitals' fee payer signer covers Solana gas — you only need USDC/USDT in the wallet.
              Cards arrive in My Pulls on success.
            </p>
          </section>
        ) : (
          <PhygitalsPullReveal items={pulled} onDone={onClose} />
        )}
      </div>
    </div>
  );
}

function PhygitalsPullReveal({ items, onDone }: { items: PhygitalsPullItem[]; onDone: () => void }) {
  return (
    <section className="phygitals-modal-section phygitals-reveal-section">
      <h3>You pulled {items.length} {items.length === 1 ? 'card' : 'cards'}</h3>
      <div className="phygitals-reveal-grid">
        {items.map((item) => {
          const image = item.content?.metadata?.image ?? item.content?.links?.image;
          const name = item.content?.metadata?.name ?? item.id;
          return (
            <article key={item.id} className="phygitals-reveal-card">
              {image && <img src={image} alt={name} loading="lazy" />}
              <strong>{name}</strong>
              <span className="phygitals-reveal-buyback">Buyback: {formatUsd(item.buyback_price)}</span>
            </article>
          );
        })}
      </div>
      <button className="primary-cta" onClick={onDone}>Done</button>
    </section>
  );
}

// ============================================================================
// My Pulls tab (client-only inventory)
// ============================================================================

export function PhygitalsMyPullsTab({ profile, refreshNonce, onChanged }: {
  profile: ProfileState;
  refreshNonce: number;
  onChanged: () => void;
}) {
  const [pulls, setPulls] = useState<StoredPull[]>(() => loadPulls(profile));

  useEffect(() => {
    setPulls(loadPulls(profile));
  }, [profile, refreshNonce]);

  const handleSold = useCallback((itemId: string, amount: number) => {
    const updated = pulls.map((p) =>
      p.id === itemId ? { ...p, soldBack: true, soldBackAmount: amount } : p,
    );
    setPulls(updated);
    savePulls(profile, updated);
    onChanged();
  }, [pulls, profile, onChanged]);

  const unsold = pulls.filter((p) => !p.soldBack);
  const sold = pulls.filter((p) => p.soldBack);

  if (pulls.length === 0) {
    return (
      <div className="panel">
        <p className="empty-state">
          Nothing here yet. Buy a Phygitals pack from the Shop tab to see your pulled cards here.
        </p>
        <p className="phygitals-purchase-note">
          Note: this list is stored locally in your browser. The Phygitals API doesn't currently
          expose a per-user inventory endpoint, so clearing browser data will hide your pulls here
          (but the on-chain assets in your wallet are unaffected).
        </p>
      </div>
    );
  }

  return (
    <>
      {unsold.length > 0 && (
        <div className="phygitals-vault-grid">
          {unsold.map((pull) => (
            <PhygitalsPullCard
              key={pull.id}
              pull={pull}
              profile={profile}
              onSold={(amount) => handleSold(pull.id, amount)}
            />
          ))}
        </div>
      )}
      {sold.length > 0 && (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">History</p>
              <h2>Sold back ({sold.length})</h2>
            </div>
          </div>
          <ul className="phygitals-sold-list">
            {sold.map((pull) => (
              <li key={pull.id}>
                <span>{pull.content?.metadata?.name ?? pull.id}</span>
                <strong>{formatUsd(pull.soldBackAmount)}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function PhygitalsPullCard({ pull, profile, onSold }: {
  pull: StoredPull;
  profile: ProfileState;
  onSold: (amount: number) => void;
}) {
  const [busy, setBusy] = useState<'init' | 'sign' | 'finish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const image = pull.content?.metadata?.image ?? pull.content?.links?.image;
  const name = pull.content?.metadata?.name ?? pull.id;
  const sellbackTarget = pull.mint_address ?? pull.id;
  const buyerWallet = profile.wallet?.address;

  const handleSell = useCallback(async () => {
    if (!buyerWallet) {
      setError('Connect a wallet to sell back.');
      return;
    }
    if (!window.confirm(`Sell back ${name} for ~${formatUsd(pull.buyback_price)}?`)) return;
    setBusy('init');
    setError(null);
    try {
      const init = await initPhygitalsSellback(sellbackTarget);
      setBusy('sign');
      const signedTxBytes = await signManyVersionedTransactions({
        payerAddress: buyerWallet,
        transactions: init.txV0s,
      });
      setBusy('finish');
      await finishPhygitalsSellback({ session_id: init.session_id, signedTxBytes });
      onSold(pull.buyback_price ?? 0);
    } catch (err) {
      setError(err instanceof PhygitalsApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [buyerWallet, name, onSold, pull.buyback_price, sellbackTarget]);

  return (
    <article className="phygitals-vault-card">
      {image && <img src={image} alt={name} loading="lazy" />}
      <div className="phygitals-vault-body">
        <strong>{name}</strong>
        <div className="phygitals-vault-row">
          <span>Buyback</span>
          <strong>{formatUsd(pull.buyback_price)}</strong>
        </div>
        <div className="phygitals-vault-actions">
          <button className="secondary-cta" onClick={handleSell} disabled={busy !== null}>
            {busy === 'init'
              ? 'Preparing…'
              : busy === 'sign'
                ? 'Approve in wallet…'
                : busy === 'finish'
                  ? 'Submitting…'
                  : 'Sell back'}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </article>
  );
}

// ============================================================================
// Helper exported for BoostersPage so it can persist pulls when a buy completes
// ============================================================================

export function recordPhygitalsPulls(profile: ProfileState, items: PhygitalsPullItem[]): void {
  if (items.length === 0) return;
  const existing = loadPulls(profile);
  const seen = new Set(existing.map((p) => p.id));
  const merged: StoredPull[] = [...existing];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    merged.push({ ...item, recordedAt: new Date().toISOString() });
  }
  savePulls(profile, merged);
}
