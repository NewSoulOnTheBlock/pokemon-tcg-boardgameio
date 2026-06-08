// Champions Row — daily lottery for trainers who have completed the
// full campaign (8 gym badges + Elite Four + Champion) AND hold any
// $POKETCG. One winner is drawn each UTC midnight and receives a
// premium 10-card pack (3C + 3U + 4 chase-rares).
//
// The page itself is informational — buttons only show up if the
// signed-in user is the winner. Everyone else sees:
//   - the 8-step explainer (Pokemasters-flavoured)
//   - their eligibility chips (Badges / E4 / Champion / $POKETCG)
//   - a count of how many trainers are in today's pool
//   - a live countdown to the next draw

import { useCallback, useEffect, useState } from 'react';
import type { ProfileState } from '../shared/profile';
import {
  claimChampionsRow,
  fetchChampionsRowStatus,
  type ChampionsRowStatus,
} from '../api/rewards';
import { PackOpeningCeremony } from '../rewards/PackOpeningCeremony';

const STEPS: Array<{ n: string; title: string; body: string }> = [
  { n: '01', title: 'Defeat the League', body: 'Earn all 8 Gym Badges, sweep the Elite Four, then beat the Champion. Your campaign progress is your eligibility — no sign-up, no claim form.' },
  { n: '02', title: 'Hold $POKETCG', body: 'Any wallet balance counts as your entry into the daily draw. There is no staking transaction, claim form, or manual sign-up to join.' },
  { n: '03', title: 'Pool snapshots at midnight', body: 'At UTC midnight the engine reads every trainer who has cleared the campaign AND holds $POKETCG. Zero-balance and unverified wallets are removed from eligibility.' },
  { n: '04', title: 'Premium pack rolls', body: 'A 10-card major pack is rolled server-side: 3 commons, 3 uncommons, and 4 chase-rare slots weighted toward Hyper Rare, Special Illustration Rare, and Ultra Rare pulls.' },
  { n: '05', title: 'Champion seed', body: 'A 32-byte server seed plus the draw date are run through HMAC-SHA-256. The first four bytes pick a winner modulo the eligible-pool size — weighted equally, not by manual choice.' },
  { n: '06', title: 'The winner is up', body: 'The signed-in winner sees a CLAIM button on this page. Open the pack as a full-screen ceremony and the 10 cards are added to your in-game collection immediately.' },
  { n: '07', title: 'Proof exposed', body: 'After the draw closes the seed and HMAC digest are recorded server-side so the result is verifiable later. The same draw can never be replayed — the date key is unique.' },
  { n: '08', title: 'New draw at UTC midnight', body: 'A fresh draw opens automatically every 24 hours. Keep your $POKETCG balance positive and keep clearing campaigns on new wallets to multiply your chances.' },
];

const BASICS: Array<[string, string]> = [
  ['Entry', 'Defeat campaign + hold $POKETCG'],
  ['Draw window', '24h (UTC)'],
  ['Draw engine', 'HMAC-SHA-256 commit'],
  ['Eligibility check', 'Server scan + on-chain RPC'],
  ['Pack composition', '3C + 3U + 4 chase-rare'],
  ['Winner claim mode', 'In-game collection (no NFT mint)'],
];

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function ChampionsRowPage({
  profile,
  onProfileChange,
}: {
  profile: ProfileState;
  onProfileChange: (next: ProfileState) => void;
}) {
  const [status, setStatus] = useState<ChampionsRowStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    if (!profile.userId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchChampionsRowStatus(profile);
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const cp = profile.campaignProgress;
  const badges = cp?.earnedBadges?.length ?? 0;
  const e4Done = cp ? cp.defeatedOpponents.filter((o) => o.startsWith('e4-')).length : 0;
  const championDone = Boolean(cp?.championDefeated);
  const campaignReady = badges >= 8 && e4Done >= 4 && championDone;
  const remainingMs = status ? Math.max(0, Date.parse(status.nextDrawAt) - now) : 0;

  const claim = useCallback(async () => {
    if (!status?.youWon) return;
    setBusy(true);
    setError(null);
    try {
      const result = await claimChampionsRow(profile);
      onProfileChange({ ...profile, ...result.profile });
      setReveal(result.purchase.cardIds);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onProfileChange, profile, refresh, status?.youWon]);

  return (
    <main className="content-page champions-row-page">
      <header className="champions-hero">
        <div>
          <p className="eyebrow">Champions Row</p>
          <h1>One major pack per day. One winner.</h1>
          <p>
            Earn every Gym Badge, defeat the Elite Four and the Champion, hold $POKETCG, and you're
            in the daily pool. No sign-up. No claim form. The engine rolls one winner each UTC
            midnight and credits the major pack to their collection.
          </p>
        </div>
        <div className="champions-hero-countdown">
          <p className="eyebrow">Next draw</p>
          <strong>{status ? formatCountdown(remainingMs) : '--:--:--'}</strong>
          <span>UTC midnight</span>
        </div>
      </header>

      <section className="panel champions-eligibility">
        <h2>Your eligibility</h2>
        <div className="champions-eligibility-grid">
          <Chip label="Gym badges" value={`${badges} / 8`} ready={badges >= 8} />
          <Chip label="Elite Four" value={`${e4Done} / 4`} ready={e4Done >= 4} />
          <Chip label="Champion" value={championDone ? 'Defeated' : 'Pending'} ready={championDone} />
          <Chip
            label="$POKETCG"
            value={profile.wallet?.chain === 'solana' ? (status?.youAreEligible ? 'Holding' : 'Required') : 'Wallet?'}
            ready={status?.youAreEligible ?? false}
          />
        </div>
        <p className="champions-eligibility-summary">
          {campaignReady
            ? (status?.youAreEligible
              ? '✅ You are in today\'s pool.'
              : '⚠ Campaign complete — connect a Solana wallet with > 0 $POKETCG to enter.')
            : '⚔ Defeat the League first to qualify for the daily draw.'}
        </p>
      </section>

      <section className="panel champions-today">
        <div className="champions-today-header">
          <div>
            <p className="eyebrow">Today's draw</p>
            <h2>{status?.dateKey ?? '—'}</h2>
            <p className="section-subtitle">
              {loading
                ? 'Loading draw…'
                : status
                  ? `${status.eligibility.totalEligible} eligible trainers · ${status.eligibility.campaignComplete} cleared the campaign · ${status.eligibility.withPoketcg} hold $POKETCG`
                  : 'Draw not available.'}
            </p>
          </div>
          {status?.youWon && (
            <div className="champions-today-banner">
              <strong>🏆 You won today's draw!</strong>
              <span>{status.youClaimed ? 'Pack already added to your collection.' : 'Claim your major pack now.'}</span>
            </div>
          )}
        </div>
        <div className="champions-today-actions">
          {status?.youWon && !status.youClaimed && (
            <button className="primary-cta champions-claim" onClick={claim} disabled={busy}>
              {busy ? 'Opening…' : '🎁 Claim Major Pack'}
            </button>
          )}
          {status?.youWon && status.youClaimed && reveal == null && (
            <p className="champions-already-claimed">Already claimed — see your collection.</p>
          )}
          {!status?.youWon && status?.winnerWallet && (
            <p className="champions-winner-bystander">
              Today's winner: <code>{status.winnerWallet.slice(0, 4)}…{status.winnerWallet.slice(-4)}</code>.
              New draw in {formatCountdown(remainingMs)}.
            </p>
          )}
          {!status?.youWon && !status?.winnerWallet && status && (
            <p className="champions-winner-bystander">No eligible trainers today. Be the first tomorrow.</p>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel champions-steps">
        <h2>How it works</h2>
        <ol className="champions-steps-grid">
          {STEPS.map((step) => (
            <li key={step.n} className="champions-step">
              <span className="champions-step-num">{step.n}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel champions-basics">
        <h2>The basics</h2>
        <dl className="champions-basics-grid">
          {BASICS.map(([k, v]) => (
            <div key={k} className="champions-basics-row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      {reveal && (
        <PackOpeningCeremony
          cardIds={reveal}
          title="Champions Row Major Pack"
          eyebrow={`Daily winner · ${status?.dateKey ?? ''}`}
          onClose={() => setReveal(null)}
        />
      )}
    </main>
  );
}

function Chip({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className={`champions-chip${ready ? ' champions-chip-ready' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
