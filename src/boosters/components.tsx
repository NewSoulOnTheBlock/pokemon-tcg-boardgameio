import { useState, type ReactNode } from 'react';
import type { Card } from '../game/types';
import type { ProfileState } from '../shared/profile';
import { collectionSize, nftOwnedCount } from '../shared/profile';
import { computeTypeBreakdown } from '../profile/data';
import {
  BOOSTER_ERAS,
  applyFilterAndSort,
  computeSetCompletion,
  eraForSet,
  getRarityEffectClass,
  groupSetsByEra,
  summarisePackPurchase,
  type BoosterEra,
  type BoosterFilter,
  type BoosterSort,
  type SetMetaLike,
} from './helpers';

export type BoosterTabId = 'shop' | 'vault' | 'pulls' | 'collection';

export const BOOSTER_TABS: Array<{ id: BoosterTabId; label: string; icon: string }> = [
  { id: 'shop', label: 'Shop', icon: '🛒' },
  { id: 'vault', label: 'My Vault', icon: '🔒' },
  { id: 'pulls', label: 'Recent Pulls', icon: '🎁' },
  { id: 'collection', label: 'In-game Collection', icon: '🃏' },
];

export function BoosterTabs({ active, onChange }: { active: BoosterTabId; onChange: (id: BoosterTabId) => void }) {
  return (
    <nav className="profile-tabs" role="tablist" aria-label="Boosters sections">
      {BOOSTER_TABS.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          tabIndex={active === tab.id ? 0 : -1}
          className={`profile-tab${active === tab.id ? ' profile-tab-active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          <span aria-hidden="true">{tab.icon}</span> {tab.label}
        </button>
      ))}
    </nav>
  );
}

export function BoosterHero({
  profile,
  featuredSet,
  priceLabel,
  onBuy,
  onJumpToCollection,
}: {
  profile: ProfileState;
  featuredSet?: SetMetaLike & { logo?: string };
  priceLabel: string;
  onBuy: () => void;
  onJumpToCollection: () => void;
}) {
  const featuredHasLogo = Boolean(featuredSet?.logo);
  return (
    <section className="trainer-hero booster-hero">
      <div className="trainer-hero-center">
        <p className="eyebrow">⚡ Open Booster Packs</p>
        <h1 className="trainer-hero-name">Build your collection, discover rare cards, and strengthen your deck one pack at a time.</h1>
        <p className="trainer-hero-wallet">
          Every booster purchase is powered by Pump.fun's Agent Payments infrastructure and secured through Solana smart contracts. Transactions are wallet-signed, verified on-chain, and recorded transparently, so you always stay in control of your assets. The same signature also covers the small SOL gas fee to mint your 8 NFT cards.
        </p>
        <ul className="booster-hero-bullets">
          <li>🎴 Collect rare and legendary cards</li>
          <li>✨ Chase holographic and special-edition pulls</li>
          <li>🏆 Complete sets and earn collection rewards</li>
          <li>🔒 Secure, on-chain payment verification</li>
          <li>⚡ Fast Solana-powered transactions</li>
        </ul>
        <p className="booster-hero-tagline">Your next favorite card could be just one pack away.</p>
        <div className="trainer-hero-stats">
          <div className="hero-stat"><strong>{profile.packsOpened}</strong><span>Packs opened</span></div>
          <div className="hero-stat"><strong>{nftOwnedCount(profile)}</strong><span>NFT cards owned</span></div>
          <div className="hero-stat"><strong>{collectionSize(profile.ownedCards)}</strong><span>Playable collection</span></div>
          <div className="hero-stat"><strong>{priceLabel}</strong><span>Per pack</span></div>
        </div>
        <div className="booster-hero-actions">
          {featuredSet && (
            <button className="primary-cta" onClick={onBuy}>🛒 Open Packs</button>
          )}
          <button className="secondary-cta" onClick={onJumpToCollection}>📊 View Collection</button>
        </div>
      </div>
      {featuredSet && (
        <div className="booster-hero-featured">
          <p className="eyebrow">Featured set</p>
          {featuredHasLogo ? (
            <img src={featuredSet.logo} alt={featuredSet.name} className="booster-hero-featured-art" />
          ) : (
            <div className="booster-hero-featured-fallback">{featuredSet.name}</div>
          )}
          <strong>{featuredSet.name}</strong>
          <span>{featuredSet.series} · {new Date(featuredSet.releaseDate).getFullYear() || '—'}</span>
        </div>
      )}
    </section>
  );
}

export function BoosterFiltersBar({
  search,
  filter,
  sort,
  onSearch,
  onFilter,
  onSort,
}: {
  search: string;
  filter: BoosterFilter;
  sort: BoosterSort;
  onSearch: (v: string) => void;
  onFilter: (v: BoosterFilter) => void;
  onSort: (v: BoosterSort) => void;
}) {
  return (
    <div className="booster-filters-bar">
      <input
        type="search"
        className="set-filter"
        placeholder="🔍 Search by name, era, or set code…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <label className="deck-select">
        Show
        <select value={filter} onChange={(e) => onFilter(e.target.value as BoosterFilter)}>
          <option value="all">All sets</option>
          <option value="owned">Sets I own packs from</option>
          <option value="not-completed">Not completed</option>
          <option value="completed">Completed</option>
        </select>
      </label>
      <label className="deck-select">
        Sort
        <select value={sort} onChange={(e) => onSort(e.target.value as BoosterSort)}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="name-asc">A → Z</option>
          <option value="completion-desc">Completion %</option>
          <option value="most-owned">Most opened</option>
        </select>
      </label>
    </div>
  );
}

export function BoosterEraSection<T extends SetMetaLike & { logo?: string; symbol?: string; totalCards?: number }>({
  era,
  sets,
  profile,
  cardLibrary,
  priceLabel,
  buyingSetId,
  onBuy,
}: {
  era: BoosterEra;
  sets: T[];
  profile: ProfileState;
  cardLibrary: Record<string, Card>;
  priceLabel: string;
  buyingSetId: string | null;
  onBuy: (set: T) => void;
}) {
  const [open, setOpen] = useState(era.defaultExpanded);
  return (
    <section className="panel booster-era-section">
      <header className="booster-era-header">
        <button
          type="button"
          className="booster-era-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true">{open ? '▼' : '▶'}</span>
          <strong>{era.label}</strong>
          <span className="booster-era-count">{sets.length} set{sets.length === 1 ? '' : 's'}</span>
        </button>
      </header>
      {open && (
        <div className="set-pack-grid">
          {sets.map((set) => {
            const stats = computeSetCompletion(profile, set, cardLibrary);
            const completed = stats.total > 0 && stats.owned >= stats.total;
            const releaseYear = Number.parseInt(set.releaseDate.slice(0, 4), 10) || '';
            const owned = stats.packsPurchased > 0;
            return (
              <article
                key={set.id}
                className={`set-pack-card${owned ? ' set-pack-card-owned' : ''}${completed ? ' set-pack-card-completed' : ''}`}
              >
                <div className="set-pack-art">
                  {set.logo ? (
                    <img className="set-pack-logo" src={set.logo} alt={`${set.name} logo`} loading="lazy" />
                  ) : (
                    <div className="set-pack-logo-fallback">{set.name}</div>
                  )}
                  {set.symbol && <img className="set-pack-symbol" src={set.symbol} alt="" loading="lazy" />}
                </div>
                <div className="set-pack-meta">
                  <strong>{set.name}</strong>
                  <span>{set.series}{releaseYear ? ` · ${releaseYear}` : ''}</span>
                  <span>{stats.total} cards in pool</span>
                  {(owned || stats.owned > 0) && (
                    <>
                      <div className="set-pack-progress-bar">
                        <div className="set-pack-progress-fill" style={{ width: `${stats.pct}%` }} />
                      </div>
                      <span className="set-pack-progress-text">
                        {stats.owned} / {stats.total} unique · {stats.pct.toFixed(1)}% · {stats.packsPurchased} pack{stats.packsPurchased === 1 ? '' : 's'} opened
                      </span>
                    </>
                  )}
                  {completed && <span className="set-pack-completed-pill">✓ Set Complete</span>}
                </div>
                <button
                  className="primary-cta set-pack-buy"
                  disabled={buyingSetId !== null}
                  onClick={() => onBuy(set)}
                >
                  {buyingSetId === set.id ? 'Opening…' : `🛒 Buy · ${priceLabel}`}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function RecentOpeningsTab({
  profile,
  cardLibrary,
  setMetaById,
  onBuyAgain,
  buyingSetId,
  priceLabel,
}: {
  profile: ProfileState;
  cardLibrary: Record<string, Card>;
  setMetaById: Map<string, SetMetaLike & { logo?: string }>;
  onBuyAgain: (setId: string) => void;
  buyingSetId: string | null;
  priceLabel: string;
}) {
  const purchases = [...(profile.packPurchases ?? [])].reverse();
  if (purchases.length === 0) {
    return (
      <BoosterEmptyState
        title="You haven't opened any packs yet"
        description="Head to the Shop tab to buy your first booster. Each pack mints 8 cards as NFTs to your wallet."
        actionLabel="Go to Shop"
      />
    );
  }
  // Walk forward through purchases so "new cards" reflects what was new
  // at the time of opening, not what's new given the current collection.
  const seen = new Set<string>();
  const summaries = (profile.packPurchases ?? []).map((purchase) => {
    const before = new Set(seen);
    for (const cardId of purchase.cardIds) seen.add(cardId);
    return summarisePackPurchase(purchase, cardLibrary, before);
  }).reverse();

  return (
    <div className="recent-openings-list">
      {summaries.map((entry) => {
        const meta = setMetaById.get(entry.setId);
        const setName = meta?.name ?? entry.setId;
        return (
          <article className="recent-opening-row" key={entry.purchase.signature || `${entry.setId}-${entry.purchase.openedAt}`}>
            <div className="recent-opening-header">
              <div>
                <strong>{setName}</strong>
                <span className="recent-opening-meta">
                  Opened {new Date(entry.purchase.openedAt).toLocaleString()}
                  {entry.purchase.mints && entry.purchase.mints.length > 0 && ` · ${entry.purchase.mints.length} NFT${entry.purchase.mints.length === 1 ? '' : 's'} minted`}
                  {entry.newCards > 0 && ` · ✨ ${entry.newCards} new`}
                </span>
              </div>
              <button
                className="primary-cta"
                disabled={buyingSetId !== null}
                onClick={() => onBuyAgain(entry.setId)}
              >
                {buyingSetId === entry.setId ? 'Buying…' : `🔁 Buy another · ${priceLabel}`}
              </button>
            </div>
            <div className="recent-opening-cards">
              {entry.purchase.cardIds.map((cardId, idx) => {
                const card = cardLibrary[cardId];
                if (!card) return null;
                const rarityClass = getRarityEffectClass(card.rarity);
                return (
                  <div key={`${cardId}-${idx}`} className={`recent-opening-card ${rarityClass}`} title={`${card.name} · ${card.rarity ?? 'No rarity'}`}>
                    {card.images?.small && <img src={card.images.small} alt={card.name} loading="lazy" />}
                  </div>
                );
              })}
            </div>
            <div className="recent-opening-rarity-summary">
              {Object.entries(entry.rarities).map(([rarity, count]) => (
                <span key={rarity} className={`rarity-chip ${getRarityEffectClass(rarity)}`}>{rarity}: {count}</span>
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function CollectionTab({ profile, totalUniqueCardsInLibrary }: { profile: ProfileState; totalUniqueCardsInLibrary: number }) {
  const ownedUnique = new Set<string>();
  for (const purchase of profile.packPurchases ?? []) {
    for (const mint of purchase.mints ?? []) ownedUnique.add(mint.cardId);
  }
  for (const imported of profile.importedNfts ?? []) ownedUnique.add(imported.cardId);
  const total = totalUniqueCardsInLibrary;
  const pct = total > 0 ? (ownedUnique.size / total) * 100 : 0;
  const missing = Math.max(0, total - ownedUnique.size);
  const typeBreakdown = computeTypeBreakdown(profile);
  const totalNfts = nftOwnedCount(profile);

  if (ownedUnique.size === 0 && totalNfts === 0) {
    return (
      <BoosterEmptyState
        title="Your collection is empty"
        description="Open your first booster to start your collection."
        actionLabel="Go to Shop"
      />
    );
  }

  return (
    <section className="panel collection-tab-panel">
      <div className="collection-tab-overview">
        <div className="collection-tab-overview-stat">
          <strong>{totalNfts}</strong>
          <span>Total NFT cards owned</span>
        </div>
        <div className="collection-tab-overview-stat">
          <strong>{ownedUnique.size}</strong>
          <span>Unique cards</span>
        </div>
        <div className="collection-tab-overview-stat">
          <strong>{missing}</strong>
          <span>Cards missing</span>
        </div>
        <div className="collection-tab-overview-stat">
          <strong>{pct.toFixed(2)}%</strong>
          <span>Library complete</span>
        </div>
      </div>
      <div className="collection-progress-bar">
        <div className="collection-progress-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="collection-progress-types">
        <h3>Type breakdown</h3>
        {typeBreakdown.map((entry) => {
          const tpct = entry.total > 0 ? (entry.owned / entry.total) * 100 : 0;
          return (
            <div className="type-progress-row" key={entry.type}>
              <span className="type-progress-label" style={{ color: entry.color }}>{entry.type}</span>
              <div className="type-progress-bar">
                <div className="type-progress-fill" style={{ width: `${tpct}%`, background: entry.color }} />
              </div>
              <span className="type-progress-count">{entry.owned} / {entry.total}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function BoosterEmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon = '📦',
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
}) {
  return (
    <div className="lobby-empty-state">
      <span className="lobby-empty-emoji" aria-hidden="true">{icon}</span>
      <p>{title}</p>
      <p style={{ color: 'var(--ink-secondary)', fontSize: '0.85rem' }}>{description}</p>
      {actionLabel && onAction && (
        <button className="primary-cta" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

// Re-export for App.tsx to consume in a single import.
export { BOOSTER_ERAS, applyFilterAndSort, eraForSet, groupSetsByEra };
