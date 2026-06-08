// Collector Crypt Gacha storefront — replaces the old Phygitals
// boosters page. Lets the user pick a machine, sign a USDC tx,
// auto-submit + open the pack, see the NFT reveal, and (within 72h)
// sell it back for USDC.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProfileState } from '../shared/profile';
import {
  GachaApiError,
  fetchGachaMachines,
  fetchGachaStatus,
  generateGachaBuyback,
  generateGachaPack,
  openGachaPack,
  signGachaBase64Transaction,
  submitGachaTransaction,
  type GachaMachine,
  type GachaOpenPackSuccess,
  type GachaRarity,
  type GachaStatus,
} from '../api/gacha';
import {
  BUYBACK_WINDOW_MS,
  buybackWindowRemainingMs,
  canBuyback,
  loadGachaVault,
  markBuybackComplete,
  recordGachaPull,
  type GachaPullRecord,
} from './vaultStore';

export type GachaTabId = 'shop' | 'vault';
const TABS: Array<{ id: GachaTabId; label: string; icon: string }> = [
  { id: 'shop', label: 'Shop', icon: '🎰' },
  { id: 'vault', label: 'My Pulls', icon: '🎁' },
];

function formatUsd(usdcBaseUnits: number | undefined): string {
  if (usdcBaseUnits === undefined || !Number.isFinite(usdcBaseUnits)) return '—';
  return `$${(usdcBaseUnits / 1_000_000).toFixed(2)}`;
}

function rarityColor(rarity: GachaRarity): string {
  switch (rarity) {
    case 'Epic': return '#f97316';
    case 'Rare': return '#a855f7';
    case 'Uncommon': return '#3b82f6';
    default: return '#64748b';
  }
}

function readInsuredValue(nft: GachaOpenPackSuccess['nftWon']): number | undefined {
  const attrs = nft?.content?.metadata?.attributes ?? [];
  for (const a of attrs) {
    const tt = (a?.trait_type ?? '').toString().toLowerCase();
    if (tt === 'insured_value' || tt === 'insured value' || tt === 'insuredvalue') {
      const v = Number(a?.value);
      if (Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

// ============================================================================
// Top-level page
// ============================================================================

export function GachaStorefront({ profile }: { profile: ProfileState }) {
  const [tab, setTab] = useState<GachaTabId>('shop');
  return (
    <main className="content-page gacha-page">
      <GachaHero />
      <nav className="profile-tabs" role="tablist" aria-label="Boosters sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`profile-tab${tab === t.id ? ' profile-tab-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span aria-hidden="true">{t.icon}</span> {t.label}
          </button>
        ))}
      </nav>
      {tab === 'shop' && <GachaShopTab profile={profile} />}
      {tab === 'vault' && <GachaVaultTab profile={profile} />}
    </main>
  );
}

// ============================================================================
// Hero
// ============================================================================

function GachaHero() {
  const [status, setStatus] = useState<GachaStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchGachaStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch((err: Error) => { if (!cancelled) setStatus({ enabled: false, error: err.message }); });
    return () => { cancelled = true; };
  }, []);
  const isLive = status?.enabled && status?.machineStatus === 'running';
  return (
    <section className="panel gacha-hero">
      <div className="gacha-hero-body">
        <p className="eyebrow">Booster Shop</p>
        <h1>Mystery Pack NFTs</h1>
        <p>
          Real graded Pokemon cards delivered as NFTs straight to your Solana wallet.
          Powered by <a href="https://gacha.collectorcrypt.com" target="_blank" rel="noreferrer">Collector Crypt</a>.
          Sell anything back for USDC within 72 hours.
        </p>
      </div>
      <div className={`gacha-hero-status gacha-hero-status-${isLive ? 'live' : 'off'}`}>
        <span className="gacha-hero-status-dot" aria-hidden="true" />
        {!status ? 'Checking machine…'
          : !status.enabled ? 'Storefront not configured'
            : status.machineStatus === 'stopped' ? 'Machine stopped'
              : 'Machine running'}
      </div>
    </section>
  );
}

// ============================================================================
// Shop tab
// ============================================================================

function GachaShopTab({ profile }: { profile: ProfileState }) {
  const [machines, setMachines] = useState<GachaMachine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeMachine, setActiveMachine] = useState<GachaMachine | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchGachaMachines()
      .then(({ machines }) => { if (!cancelled) setMachines(machines.filter((m) => m.public !== false)); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="panel"><p className="empty-state">Loading gacha machines…</p></div>;
  if (error) return <div className="panel"><p className="error">Couldn't load machines: {error}</p></div>;
  if (machines.length === 0) return <div className="panel"><p className="empty-state">No machines available right now.</p></div>;

  return (
    <>
      <div className="gacha-grid">
        {machines.map((m) => (
          <GachaMachineCard key={m.code} machine={m} onOpen={() => setActiveMachine(m)} />
        ))}
      </div>
      {activeMachine && (
        <GachaBuyModal
          machine={activeMachine}
          profile={profile}
          onClose={() => setActiveMachine(null)}
        />
      )}
    </>
  );
}

function GachaMachineCard({ machine, onOpen }: { machine: GachaMachine; onOpen: () => void }) {
  const totalStock = (Object.values(machine.stock ?? {}) as number[]).reduce((a, b) => a + (b ?? 0), 0);
  const soldOut = totalStock === 0;
  const buyback = machine.instantBuyback ?? 0;
  return (
    <article className={`gacha-card${soldOut ? ' gacha-card-soldout' : ''}`}>
      <div className="gacha-card-art">
        {machine.thumbnailUrl || machine.image ? (
          <img src={machine.thumbnailUrl ?? machine.image} alt={machine.name} loading="lazy" />
        ) : (
          <div className="gacha-card-art-placeholder">{machine.shortName ?? machine.name}</div>
        )}
        <div className="gacha-card-art-badge">${machine.price}</div>
      </div>
      <div className="gacha-card-body">
        <h3>{machine.name}</h3>
        {machine.contains && <p className="gacha-card-contains">{machine.contains}</p>}
        <ul className="gacha-card-odds">
          <li><span className="rarity-dot rarity-epic" />Epic {((machine.odds?.epic ?? 0) * 100).toFixed(1)}%</li>
          <li><span className="rarity-dot rarity-rare" />Rare {((machine.odds?.rare ?? 0) * 100).toFixed(1)}%</li>
          <li><span className="rarity-dot rarity-uncommon" />Uncommon {((machine.odds?.uncommon ?? 0) * 100).toFixed(1)}%</li>
          <li><span className="rarity-dot rarity-common" />Common {((machine.odds?.common ?? 0) * 100).toFixed(1)}%</li>
        </ul>
        <div className="gacha-card-meta">
          <span>Stock: <strong>{totalStock.toLocaleString()}</strong></span>
          <span>Buyback: <strong>{buyback}%</strong></span>
        </div>
        <button className="primary-cta" onClick={onOpen} disabled={soldOut}>
          {soldOut ? 'Sold out' : `Buy for $${machine.price}`}
        </button>
      </div>
    </article>
  );
}

// ============================================================================
// Buy modal — full purchase + reveal flow in one component
// ============================================================================

type BuyState =
  | { kind: 'idle' }
  | { kind: 'sign' }
  | { kind: 'submit'; memo: string }
  | { kind: 'open'; memo: string; attempt: number }
  | { kind: 'reveal'; memo: string; result: GachaOpenPackSuccess }
  | { kind: 'error'; message: string };

function GachaBuyModal({ machine, profile, onClose }: { machine: GachaMachine; profile: ProfileState; onClose: () => void }) {
  const wallet = profile.wallet?.chain === 'solana' ? profile.wallet.address : undefined;
  const [turbo, setTurbo] = useState(false);
  const [state, setState] = useState<BuyState>({ kind: 'idle' });

  const buy = useCallback(async () => {
    if (!wallet) {
      setState({ kind: 'error', message: 'Connect a Solana wallet first.' });
      return;
    }
    try {
      setState({ kind: 'sign' });
      const { memo, transaction } = await generateGachaPack({
        playerAddress: wallet,
        packType: machine.code,
        turbo,
      });
      const signed = await signGachaBase64Transaction({ payerAddress: wallet, base64Tx: transaction });
      setState({ kind: 'submit', memo });
      await submitGachaTransaction(signed);
      // Begin polling /open — gacha needs a moment for the webhook to fire.
      let attempt = 0;
      setState({ kind: 'open', memo, attempt });
      // 30 attempts × 2.5s = 75s max wait.
      for (attempt = 0; attempt < 30; attempt += 1) {
        setState({ kind: 'open', memo, attempt });
        const res = await openGachaPack(memo);
        if (res.code === 'WAITING_FOR_WEBHOOK') {
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        // Success path.
        recordGachaPull(wallet, {
          memo: res.code === 'TURBO_MODE_BUYBACK' ? memo : memo,
          packType: machine.code,
          openedAt: new Date().toISOString(),
          nftAddress: res.nft_address,
          nftName: res.nftWon?.content?.metadata?.name ?? 'Mystery NFT',
          nftImage: res.nftWon?.content?.metadata?.image ?? res.nftWon?.content?.links?.image,
          rarity: res.rarity,
          insuredValueUsdc: readInsuredValue(res.nftWon),
          turboBuybackAmount: res.code === 'TURBO_MODE_BUYBACK' ? res.buybackAmount : undefined,
        });
        setState({ kind: 'reveal', memo, result: res });
        return;
      }
      setState({ kind: 'error', message: 'Pack open timed out — check your wallet, the pack will be openable from the My Pulls tab once the webhook lands.' });
    } catch (err) {
      const msg = err instanceof GachaApiError ? err.message : err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message: msg });
    }
  }, [machine.code, turbo, wallet]);

  const busy = state.kind === 'sign' || state.kind === 'submit' || state.kind === 'open';

  return (
    <div className="wager-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Buy ${machine.name}`}>
      <div className="wager-modal gacha-buy-modal">
        <button className="gacha-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        <p className="eyebrow">Buy pack</p>
        <h2>{machine.name} — ${machine.price}</h2>
        {machine.contains && <p className="wager-modal-sub">{machine.contains}</p>}

        {state.kind === 'reveal' ? (
          <GachaReveal result={state.result} machine={machine} onClose={onClose} />
        ) : (
          <>
            <ul className="gacha-card-odds">
              <li><span className="rarity-dot rarity-epic" />Epic {((machine.odds?.epic ?? 0) * 100).toFixed(1)}%</li>
              <li><span className="rarity-dot rarity-rare" />Rare {((machine.odds?.rare ?? 0) * 100).toFixed(1)}%</li>
              <li><span className="rarity-dot rarity-uncommon" />Uncommon {((machine.odds?.uncommon ?? 0) * 100).toFixed(1)}%</li>
              <li><span className="rarity-dot rarity-common" />Common {((machine.odds?.common ?? 0) * 100).toFixed(1)}%</li>
            </ul>

            <label className="gacha-turbo-toggle">
              <input
                type="checkbox"
                checked={turbo}
                onChange={(e) => setTurbo(e.target.checked)}
                disabled={busy || !machine.turboMode}
              />
              <span>
                <strong>Turbo mode</strong>
                <span className="gacha-turbo-help">
                  {machine.turboMode
                    ? `Auto-sell Common pulls for ${machine.instantBuyback ?? 0}% insured value (saves a click).`
                    : 'Not available for this machine.'}
                </span>
              </span>
            </label>

            <div className="gacha-buy-actions">
              <button className="primary-cta" onClick={buy} disabled={busy || !wallet}>
                {!wallet
                  ? 'Connect Solana wallet'
                  : state.kind === 'sign'
                    ? 'Approve in wallet…'
                    : state.kind === 'submit'
                      ? 'Submitting purchase…'
                      : state.kind === 'open'
                        ? `Opening pack… (${(state.attempt ?? 0) + 1}/30)`
                        : `Buy for $${machine.price}`}
              </button>
            </div>

            {state.kind === 'error' && (
              <p className="error gacha-buy-error">{state.message}</p>
            )}

            <p className="gacha-buy-disclaimer">
              Costs ${machine.price} USDC (mainnet). NFT is sent to your wallet on success. Sell back any
              non-turbo pull for {machine.instantBuyback ?? 85}% insured value within 72 hours.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function GachaReveal({ result, machine, onClose }: { result: GachaOpenPackSuccess; machine: GachaMachine; onClose: () => void }) {
  const turboSold = result.code === 'TURBO_MODE_BUYBACK';
  return (
    <div className="gacha-reveal" style={{ borderColor: rarityColor(result.rarity) }}>
      <p className="eyebrow" style={{ color: rarityColor(result.rarity) }}>{result.rarity}</p>
      <h3>{result.nftWon?.content?.metadata?.name ?? 'Mystery NFT'}</h3>
      {(result.nftWon?.content?.metadata?.image || result.nftWon?.content?.links?.image) ? (
        <img
          className="gacha-reveal-image"
          src={result.nftWon.content.metadata.image ?? result.nftWon.content.links?.image}
          alt={result.nftWon.content.metadata.name}
        />
      ) : (
        <div className="gacha-reveal-image gacha-reveal-image-empty">{result.rarity}</div>
      )}
      {turboSold ? (
        <p className="gacha-reveal-turbo">
          🤖 Turbo auto-sold for <strong>{formatUsd(result.buybackAmount)}</strong> USDC.
        </p>
      ) : (
        <p className="gacha-reveal-detail">
          NFT minted to your wallet. Insured at {formatUsd(readInsuredValue(result.nftWon))} ·
          buyback {machine.instantBuyback ?? 85}% within 72h.
        </p>
      )}
      <p className="gacha-reveal-tx">
        Tx: <code>{result.transactionSignature.slice(0, 10)}…{result.transactionSignature.slice(-6)}</code>
      </p>
      <div className="wager-modal-actions">
        <button className="primary-cta" onClick={onClose} type="button">Done</button>
      </div>
    </div>
  );
}

// ============================================================================
// Vault tab — My Pulls
// ============================================================================

function GachaVaultTab({ profile }: { profile: ProfileState }) {
  const walletAddress = profile.wallet?.address;
  const [pulls, setPulls] = useState<GachaPullRecord[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { setPulls(loadGachaVault(walletAddress)); }, [walletAddress]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!profile.wallet) {
    return <div className="panel"><p className="empty-state">Connect a Solana wallet to see your pulls.</p></div>;
  }
  if (pulls.length === 0) {
    return <div className="panel"><p className="empty-state">No pulls yet — open a pack from the Shop tab.</p></div>;
  }
  // Newest first.
  const ordered = [...pulls].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  return (
    <div className="gacha-vault-grid">
      {ordered.map((pull) => (
        <GachaVaultCard
          key={pull.memo}
          pull={pull}
          walletAddress={walletAddress}
          nowMs={now}
          onChanged={() => setPulls(loadGachaVault(walletAddress))}
        />
      ))}
    </div>
  );
}

function GachaVaultCard({
  pull,
  walletAddress,
  nowMs,
  onChanged,
}: {
  pull: GachaPullRecord;
  walletAddress: string | undefined;
  nowMs: number;
  onChanged: () => void;
}) {
  const eligible = canBuyback(pull, nowMs);
  const remainingMs = buybackWindowRemainingMs(pull, nowMs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sellBack = useCallback(async () => {
    if (!walletAddress) { setError('No wallet connected.'); return; }
    setError(null);
    setBusy(true);
    try {
      const { serializedTransaction, refundAmount } = await generateGachaBuyback({
        playerAddress: walletAddress,
        nftAddress: pull.nftAddress,
      });
      const signed = await signGachaBase64Transaction({
        payerAddress: walletAddress,
        base64Tx: serializedTransaction,
      });
      const { signature } = await submitGachaTransaction(signed);
      markBuybackComplete(walletAddress, pull.memo, signature);
      onChanged();
      void refundAmount; // already cached on the pull via the API response
    } catch (err) {
      const msg = err instanceof GachaApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [onChanged, pull.memo, pull.nftAddress, walletAddress]);

  const remainingLabel = (() => {
    if (pull.buybackSignature) return 'Sold back';
    if (pull.turboBuybackAmount !== undefined) return 'Turbo auto-sold';
    if (remainingMs <= 0) return 'Buyback window closed';
    const h = Math.floor(remainingMs / 3_600_000);
    const m = Math.floor((remainingMs % 3_600_000) / 60_000);
    return `${h}h ${m}m left to sell back`;
  })();

  return (
    <article className="gacha-vault-card" style={{ borderColor: rarityColor(pull.rarity) }}>
      <div className="gacha-vault-rarity" style={{ color: rarityColor(pull.rarity) }}>{pull.rarity}</div>
      {pull.nftImage ? (
        <img src={pull.nftImage} alt={pull.nftName} loading="lazy" />
      ) : (
        <div className="gacha-vault-img-empty">{pull.rarity}</div>
      )}
      <div className="gacha-vault-body">
        <strong title={pull.nftName}>{pull.nftName}</strong>
        <span className="gacha-vault-meta">
          {pull.packType} · insured {formatUsd(pull.insuredValueUsdc)}
        </span>
        <span className={`gacha-vault-window${eligible ? ' gacha-vault-window-active' : ''}`}>
          ⏳ {remainingLabel}
        </span>
        {pull.turboBuybackAmount !== undefined && (
          <span className="gacha-vault-turbo">+{formatUsd(pull.turboBuybackAmount)} USDC</span>
        )}
        {eligible && (
          <button className="primary-cta" onClick={sellBack} disabled={busy}>
            {busy ? 'Selling back…' : 'Sell back for USDC'}
          </button>
        )}
        {error && <p className="error gacha-vault-error">{error}</p>}
      </div>
    </article>
  );
}

// Re-export so App.tsx can mount it.
export { BUYBACK_WINDOW_MS };
