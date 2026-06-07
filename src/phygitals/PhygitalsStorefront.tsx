// Phygitals storefront UI — the paid, real-physical-card side of the
// boosters page. Browse → buy → vault → sellback → ship.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchPhygitalsPacks,
  fetchPhygitalsRecentPulls,
  fetchPhygitalsInventory,
  fetchPhygitalsStatus,
  phygitalsBuy,
  phygitalsSellback,
  phygitalsShipQuote,
  phygitalsShipRequest,
  PhygitalsApiError,
  type PhygitalsItem,
  type PhygitalsPack,
  type PhygitalsPull,
  type PhygitalsShipQuote,
  type PhygitalsDestination,
} from '../api/phygitals';
import type { ProfileState } from '../shared/profile';

function formatUsd(n: number | undefined): string {
  if (!Number.isFinite(n)) return '—';
  const v = Number(n);
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function userIdFor(profile: ProfileState): string {
  // Phygitals' user_id is partner-defined; we use the stable userId
  // when available, else fall back to the wallet address, else the
  // profile name as last resort. The same value is used across
  // buy/inventory/sellback/ship so all activity stays scoped.
  return profile.userId ?? profile.wallet?.address ?? profile.name;
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
// Shop tab — pack catalog
// ============================================================================

export function PhygitalsShopTab({ profile, onPurchased }: {
  profile: ProfileState;
  onPurchased: (items: PhygitalsItem[]) => void;
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

  if (loading) {
    return <div className="panel"><p className="empty-state">Loading Phygitals catalog…</p></div>;
  }
  if (error) {
    return <div className="panel"><p className="error">Phygitals: {error}</p></div>;
  }
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
          onPurchased={(items) => { onPurchased(items); }}
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
          <img src={pack.claw_image_url} alt={pack.name} loading="lazy" />
        </div>
      ) : null}
      <div className="phygitals-pack-body">
        <header className="phygitals-pack-header">
          <h3>{pack.name}</h3>
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
  onPurchased: (items: PhygitalsItem[]) => void;
}) {
  const [amount, setAmount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pulled, setPulled] = useState<PhygitalsItem[] | null>(null);
  const maxAmount = Math.max(1, pack.max_per_mint ?? 10);
  const totalCost = (pack.mint_price ?? 0) * amount;

  const handleBuy = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await phygitalsBuy({
        id: pack.id,
        amount,
        user_id: userIdFor(profile),
      });
      setPulled(result.nfts ?? []);
      onPurchased(result.nfts ?? []);
    } catch (err) {
      setError(err instanceof PhygitalsApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [amount, onPurchased, pack.id, profile]);

  return (
    <div className="phygitals-modal-backdrop" onClick={onClose}>
      <div className="phygitals-modal" onClick={(event) => event.stopPropagation()}>
        <header className="phygitals-modal-header">
          <h2>{pack.name}</h2>
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
              <div className="phygitals-purchase-total">
                <span className="label">Total</span>
                <strong>{formatUsd(totalCost)}</strong>
              </div>
              <button className="primary-cta" onClick={handleBuy} disabled={busy || pack.in_stock === false}>
                {busy ? 'Pulling…' : `Buy ${amount} pull${amount === 1 ? '' : 's'}`}
              </button>
            </div>
            {error && <p className="error">{error}</p>}
            <p className="phygitals-purchase-note">
              Phygitals settles payment + fulfillment. Cards arrive in your Vault tab on success.
            </p>
          </section>
        ) : (
          <PhygitalsPullReveal items={pulled} onDone={onClose} />
        )}
      </div>
    </div>
  );
}

function PhygitalsPullReveal({ items, onDone }: { items: PhygitalsItem[]; onDone: () => void }) {
  return (
    <section className="phygitals-modal-section phygitals-reveal-section">
      <h3>You pulled {items.length} {items.length === 1 ? 'card' : 'cards'}</h3>
      <div className="phygitals-reveal-grid">
        {items.map((item) => (
          <article key={item.id} className="phygitals-reveal-card">
            {item.content.metadata.image && (
              <img src={item.content.metadata.image} alt={item.content.metadata.name} loading="lazy" />
            )}
            <strong>{item.content.metadata.name}</strong>
            <span className="phygitals-reveal-buyback">Buyback: {formatUsd(item.buyback_price)}</span>
          </article>
        ))}
      </div>
      <button className="primary-cta" onClick={onDone}>Done</button>
    </section>
  );
}

// ============================================================================
// Vault tab — owned Phygitals inventory
// ============================================================================

export function PhygitalsVaultTab({ profile, refreshNonce, onChanged }: {
  profile: ProfileState;
  refreshNonce: number;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<PhygitalsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shippingItem, setShippingItem] = useState<PhygitalsItem | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const inv = await fetchPhygitalsInventory(userIdFor(profile));
      setItems(inv.items ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => { void reload(); }, [reload, refreshNonce]);

  if (loading) return <div className="panel"><p className="empty-state">Loading your vault…</p></div>;
  if (error) return <div className="panel"><p className="error">{error}</p></div>;
  if (items.length === 0) {
    return (
      <div className="panel">
        <p className="empty-state">Your Phygitals vault is empty. Buy a pack from the Shop tab to get started.</p>
      </div>
    );
  }

  return (
    <>
      <div className="phygitals-vault-grid">
        {items.map((item) => (
          <PhygitalsVaultCard
            key={item.id}
            item={item}
            onSold={() => { void reload(); onChanged(); }}
            onShipClick={() => setShippingItem(item)}
          />
        ))}
      </div>
      {shippingItem && (
        <PhygitalsShipModal
          item={shippingItem}
          onClose={() => setShippingItem(null)}
          onShipped={() => { setShippingItem(null); void reload(); onChanged(); }}
        />
      )}
    </>
  );
}

function PhygitalsVaultCard({ item, onSold, onShipClick }: {
  item: PhygitalsItem;
  onSold: () => void;
  onShipClick: () => void;
}) {
  const [busy, setBusy] = useState<'sell' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expiresLabel = useMemo(() => {
    if (!item.buyback_expires_at) return null;
    const ms = Date.parse(item.buyback_expires_at) - Date.now();
    if (ms <= 0) return 'Sellback expired';
    const days = Math.floor(ms / 86_400_000);
    if (days >= 1) return `Sellback in ${days}d`;
    const hours = Math.floor(ms / 3_600_000);
    return `Sellback in ${hours}h`;
  }, [item.buyback_expires_at]);

  const handleSell = useCallback(async () => {
    if (!window.confirm(`Sell back ${item.content.metadata.name} for ${item.buyback_price ? `$${item.buyback_price}` : 'buyback price'}?`)) return;
    setBusy('sell');
    setError(null);
    try {
      await phygitalsSellback(item.id);
      onSold();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [item, onSold]);

  const image = item.content.metadata.image ?? item.content.links?.image;

  return (
    <article className="phygitals-vault-card">
      {image && <img src={image} alt={item.content.metadata.name} loading="lazy" />}
      <div className="phygitals-vault-body">
        <strong>{item.content.metadata.name}</strong>
        {item.claw_slug && <span className="phygitals-vault-source">from {item.claw_slug}</span>}
        <div className="phygitals-vault-row">
          <span>Buyback</span>
          <strong>{formatUsd(item.buyback_price)}</strong>
        </div>
        {expiresLabel && <span className="phygitals-vault-expiry">{expiresLabel}</span>}
        <div className="phygitals-vault-actions">
          <button className="secondary-cta" onClick={handleSell} disabled={Boolean(busy)}>
            {busy === 'sell' ? '…' : 'Sell back'}
          </button>
          <button className="primary-cta" onClick={onShipClick}>Ship</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </article>
  );
}

const EMPTY_DEST: PhygitalsDestination = {
  name: '', line1: '', city: '', state: '', postal_code: '', country: 'US',
};

function PhygitalsShipModal({ item, onClose, onShipped }: {
  item: PhygitalsItem;
  onClose: () => void;
  onShipped: () => void;
}) {
  const [destination, setDestination] = useState<PhygitalsDestination>(EMPTY_DEST);
  const [quote, setQuote] = useState<PhygitalsShipQuote | null>(null);
  const [chosenRate, setChosenRate] = useState<string | null>(null);
  const [busy, setBusy] = useState<'quote' | 'request' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<PhygitalsDestination | null>(null);

  const updateField = useCallback(<K extends keyof PhygitalsDestination>(key: K, value: PhygitalsDestination[K]) => {
    setDestination((prev) => ({ ...prev, [key]: value }));
  }, []);

  const requestQuote = useCallback(async () => {
    setBusy('quote');
    setError(null);
    setSuggested(null);
    try {
      const result = await phygitalsShipQuote({ item_ids: [item.id], destination });
      setQuote(result);
      setChosenRate(result.quotes[0]?.id ?? null);
    } catch (err) {
      if (err instanceof PhygitalsApiError && err.suggested) {
        setSuggested(err.suggested);
        setError(`Address needs confirmation: ${err.message}`);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(null);
    }
  }, [destination, item.id]);

  const submitShipment = useCallback(async () => {
    if (!chosenRate) return;
    setBusy('request');
    setError(null);
    try {
      await phygitalsShipRequest(chosenRate);
      onShipped();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [chosenRate, onShipped]);

  const acceptSuggested = useCallback(() => {
    if (suggested) {
      setDestination(suggested);
      setSuggested(null);
      setError(null);
    }
  }, [suggested]);

  return (
    <div className="phygitals-modal-backdrop" onClick={onClose}>
      <div className="phygitals-modal" onClick={(event) => event.stopPropagation()}>
        <header className="phygitals-modal-header">
          <h2>Ship {item.content.metadata.name}</h2>
          <button className="phygitals-modal-close" aria-label="Close" onClick={onClose}>✕</button>
        </header>

        {!quote ? (
          <section className="phygitals-ship-form">
            <p className="phygitals-purchase-note">
              Shipping is billed B2B by Phygitals. No payment required from you here — confirm the address and pick a rate.
            </p>
            <label>Full name<input value={destination.name} onChange={(e) => updateField('name', e.target.value)} /></label>
            <label>Address line 1<input value={destination.line1} onChange={(e) => updateField('line1', e.target.value)} /></label>
            <label>Address line 2 (optional)<input value={destination.line2 ?? ''} onChange={(e) => updateField('line2', e.target.value)} /></label>
            <div className="phygitals-ship-grid">
              <label>City<input value={destination.city} onChange={(e) => updateField('city', e.target.value)} /></label>
              <label>State<input value={destination.state ?? ''} onChange={(e) => updateField('state', e.target.value)} /></label>
              <label>Postal code<input value={destination.postal_code ?? ''} onChange={(e) => updateField('postal_code', e.target.value)} /></label>
              <label>Country (2-letter)<input value={destination.country} maxLength={2} onChange={(e) => updateField('country', e.target.value.toUpperCase())} /></label>
            </div>
            <div className="phygitals-ship-grid">
              <label>Phone<input value={destination.phone ?? ''} onChange={(e) => updateField('phone', e.target.value)} /></label>
              <label>Email<input type="email" value={destination.email ?? ''} onChange={(e) => updateField('email', e.target.value)} /></label>
            </div>
            {error && <p className="error">{error}</p>}
            {suggested && (
              <div className="phygitals-ship-suggested">
                <p>Did you mean:</p>
                <pre>{`${suggested.name}\n${suggested.line1}${suggested.line2 ? `\n${suggested.line2}` : ''}\n${suggested.city}, ${suggested.state ?? ''} ${suggested.postal_code ?? ''}\n${suggested.country}`}</pre>
                <button className="secondary-cta" onClick={acceptSuggested}>Use this address</button>
              </div>
            )}
            <button className="primary-cta" onClick={requestQuote} disabled={busy !== null}>
              {busy === 'quote' ? 'Getting rates…' : 'Get shipping rates'}
            </button>
          </section>
        ) : (
          <section className="phygitals-ship-rates">
            <p>Choose a shipping option:</p>
            <ul className="phygitals-rate-list">
              {quote.quotes.map((rate) => (
                <li key={rate.id} className={chosenRate === rate.id ? 'phygitals-rate-active' : ''}>
                  <label>
                    <input
                      type="radio"
                      name="phygitals-rate"
                      value={rate.id}
                      checked={chosenRate === rate.id}
                      onChange={() => setChosenRate(rate.id)}
                    />
                    <div className="phygitals-rate-body">
                      <strong>{rate.carrier} — {rate.service}</strong>
                      <span>{formatUsd(rate.amount)} · {rate.estimated_days_min}-{rate.estimated_days_max} days {rate.insured && '· insured'}</span>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
            {error && <p className="error">{error}</p>}
            <div className="phygitals-ship-actions">
              <button className="secondary-cta" onClick={() => setQuote(null)}>← Back</button>
              <button className="primary-cta" onClick={submitShipment} disabled={!chosenRate || busy === 'request'}>
                {busy === 'request' ? 'Submitting…' : 'Confirm shipment'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Pulls feed
// ============================================================================

export function PhygitalsPullsTab() {
  const [pulls, setPulls] = useState<PhygitalsPull[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    function refresh() {
      fetchPhygitalsRecentPulls({ limit: 30 })
        .then((rows) => { if (!cancelled) { setPulls(rows); setError(null); } })
        .catch((err: Error) => { if (!cancelled) setError(err.message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  if (loading) return <div className="panel"><p className="empty-state">Loading recent pulls…</p></div>;
  if (error) return <div className="panel"><p className="error">{error}</p></div>;
  if (pulls.length === 0) return <div className="panel"><p className="empty-state">No recent pulls yet.</p></div>;

  return (
    <div className="phygitals-pulls-grid">
      {pulls.map((pull) => (
        <article key={pull.id} className="phygitals-pull-row">
          {pull.metadata.image && <img src={pull.metadata.image} alt={pull.metadata.name} loading="lazy" />}
          <div className="phygitals-pull-body">
            <strong>{pull.metadata.name}</strong>
            {pull.claw_slug && <span>{pull.claw_slug}</span>}
          </div>
          <div className="phygitals-pull-value">
            <strong>{formatUsd(pull.value)}</strong>
            <span>{timeAgo(pull.created_at)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

// ============================================================================
// Hero / status banner
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
        <h1>Real cards. Real liquidity. Real shipping.</h1>
        <p>
          Every pack is backed by a graded physical card held in an insured US vault.
          Reveal instantly, hold in your vault, sell back at 85% of live FMV, or ship worldwide.
        </p>
        <p className="phygitals-hero-meta">
          Signed in as <strong>{profile.name}</strong> · partner user_id: <code>{userIdFor(profile)}</code>
        </p>
      </div>
    </section>
  );
}
