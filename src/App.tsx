import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LobbyAPI } from 'boardgame.io';
import { LobbyClient } from 'boardgame.io/client';
import type { BoardProps } from 'boardgame.io/react';
import { Client } from 'boardgame.io/react';
import { SocketIO } from 'boardgame.io/multiplayer';
import {
  fetchLeaderboard,
  loginProfile,
  persistMatchRecord,
  persistPackPurchase,
  persistProfile,
} from './api/profiles';
import { MULTIPLAYER_SERVER } from './api/server';
import { CardImage } from './components/CardImage';
import {
  CARD_LIBRARY,
  ENERGY_TYPE_META,
  STARTER_DECKS,
  STARTER_ENERGY_TYPES,
  type StarterEnergyType,
} from './game/cards';
import { PokemonTCG } from './game/PokemonTCG';
import type { Card, MatchType, PlayerID, PokemonTCGSetupData, PokemonTCGState } from './game/types';
import { PokemonBoard } from './PokemonBoard';
import {
  addCardsToCollection,
  collectionFromCards,
  collectionSize,
  type CustomDeck,
  maxCollections,
  type MatchLeaderboardEntry,
  type MatchRecord,
  type PackPurchase,
  type ProfileState,
} from './shared/profile';
import {
  connectEvm,
  connectSolana,
  detectSolanaWallets,
  shortAddr,
  type ConnectedWallet,
} from './wallet';

type Page = 'signin' | 'home' | 'profile' | 'matchmaking' | 'boosters' | 'match';

interface MatchConfig {
  matchID: string;
  matchName: string;
  matchType: MatchType;
  playerDeck?: DeckPayload;
  playerID: PlayerID;
  credentials: string;
  playerDeckLabel: string;
  opponentDeckLabel: string;
  server: string;
}

interface MatchSetupData extends PokemonTCGSetupData {
  deckLabels?: Partial<Record<PlayerID, string>>;
}

interface DeckPayload {
  cardIds: string[];
  label: string;
}

interface DeckOption {
  cardIds: string[];
  id: string;
  issues: string[];
  label: string;
}

const PROFILE_KEY = 'pokemon-tcg-profile';
const DECK_SIZE = 60;
const MAX_CARD_COPIES = 4;
const PACK_PRICE_SOL = 0.1;
const PACK_PAYMENT_RECIPIENT = import.meta.env.VITE_PACK_PAYMENT_RECIPIENT?.trim() ?? '';
const SOLANA_RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const GAME_NAME = PokemonTCG.name ?? 'pokemon-tcg';
const PLAYER_IDS: PlayerID[] = ['0', '1'];
const MATCH_TYPES: MatchType[] = ['Casual', 'Ranked', 'Wager'];
const STARTER_COLLECTION = collectionFromCards(Object.values(STARTER_DECKS).flat());
const DEFAULT_PROFILE: ProfileState = {
  name: '',
  wallet: null,
  activeDeckName: 'No Custom Deck',
  customDeck: [],
  deckLibrary: [],
  ownedCards: STARTER_COLLECTION,
  packsOpened: 0,
  packPurchases: [],
  matchRecords: [],
};
const STARTER_DECK_NAMES = new Set(STARTER_ENERGY_TYPES.map((type) => `${type} Starter`));

const CANONICAL_CARDS = Object.values(CARD_LIBRARY)
  .filter((card) => card.id === (card.sourceId ?? card.id))
  .sort((a, b) => a.name.localeCompare(b.name));
const BUILDABLE_CARDS = CANONICAL_CARDS;
const BOOSTER_CARDS = CANONICAL_CARDS.filter((card) => card.rarity && card.rarity !== 'Promo');
const BOOSTER_COMMONS = BOOSTER_CARDS.filter((card) => card.rarity === 'Common');
const BOOSTER_UNCOMMONS = BOOSTER_CARDS.filter((card) => card.rarity === 'Uncommon');
const BOOSTER_ENERGY = CANONICAL_CARDS.filter((card) => card.kind === 'energy' && card.basic);
const BOOSTER_REVERSE = BOOSTER_CARDS.filter((card) => card.kind !== 'energy' && card.rarity !== 'Promo');
const BOOSTER_RARES = BOOSTER_CARDS.filter((card) => card.kind !== 'energy' && card.rarity !== 'Common' && card.rarity !== 'Uncommon');
type BoosterSlot = 'Common' | 'Uncommon' | 'Reverse Holo' | 'Rare or better' | 'Basic Energy';
interface BoosterPull {
  card: Card;
  slot: BoosterSlot;
}

function loadProfile(): ProfileState {
  try {
    const stored = localStorage.getItem(PROFILE_KEY);
    if (!stored) {
      return { ...DEFAULT_PROFILE, ownedCards: { ...DEFAULT_PROFILE.ownedCards }, customDeck: [], deckLibrary: [] };
    }

    const parsed = JSON.parse(stored) as Partial<ProfileState>;
    const legacyCustomDeck = Array.isArray(parsed.customDeck) ? parsed.customDeck : [];
    const deckLibrary = Array.isArray(parsed.deckLibrary)
      ? parsed.deckLibrary
      : legacyCustomDeck.length > 0 && parsed.activeDeckName && !STARTER_DECK_NAMES.has(parsed.activeDeckName)
        ? [makeCustomDeck(parsed.activeDeckName, legacyCustomDeck)]
        : [];
    const activeDeck = deckLibrary.find((deck) => deck.name === parsed.activeDeckName) ?? deckLibrary[0];
    const customDeck = activeDeck?.cardIds ?? [];
    return {
      ...DEFAULT_PROFILE,
      ...parsed,
      activeDeckName: activeDeck?.name ?? 'No Custom Deck',
      customDeck,
      deckLibrary,
      ownedCards: maxCollections(STARTER_COLLECTION, parsed.ownedCards ?? {}, collectionFromCards(customDeck), ...deckLibrary.map((deck) => collectionFromCards(deck.cardIds))),
      packPurchases: Array.isArray(parsed.packPurchases) ? parsed.packPurchases : [],
      matchRecords: Array.isArray(parsed.matchRecords) ? parsed.matchRecords : [],
    };
  } catch {
    return { ...DEFAULT_PROFILE, ownedCards: { ...DEFAULT_PROFILE.ownedCards }, customDeck: [], deckLibrary: [] };
  }
}

function makeDeckId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeCustomDeck(name: string, cardIds: string[], id = makeDeckId()): CustomDeck {
  const timestamp = new Date().toISOString();
  return {
    id,
    name: name.trim() || 'Untitled Deck',
    cardIds: [...cardIds],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function saveProfile(profile: ProfileState): void {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

async function loginAndStore(profile: ProfileState): Promise<ProfileState> {
  const saved = await loginProfile(profile);
  saveProfile(saved);
  return saved;
}

async function persistAndStore(profile: ProfileState): Promise<ProfileState> {
  const saved = await persistProfile(profile);
  saveProfile(saved);
  return saved;
}

async function persistPackAndStore(profile: ProfileState, purchase: PackPurchase): Promise<ProfileState> {
  const saved = await persistPackPurchase(profile, purchase);
  saveProfile(saved);
  return saved;
}

async function persistMatchAndStore(profile: ProfileState, record: MatchRecord): Promise<ProfileState> {
  const saved = await persistMatchRecord(profile, record);
  saveProfile(saved);
  return saved;
}

function cardLabel(card: Card): string {
  if (card.kind === 'pokemon') return `${card.name} - ${card.stage} ${card.pokemonType}`;
  if (card.kind === 'energy') return `${card.name} - ${card.energyType}`;
  return `${card.name} - ${card.trainerType}`;
}

function DeckbuilderCardArt({ card }: { card: Card }) {
  return <CardImage card={card} className="builder-card-art" imageClassName="builder-card-image" />;
}

function deckCounts(cards: string[]): Record<string, number> {
  return cards.reduce<Record<string, number>>((counts, cardId) => {
    counts[cardId] = (counts[cardId] ?? 0) + 1;
    return counts;
  }, {});
}

function rareBucket(card: Card): 'rare' | 'ultra' | 'illustration' | 'secret' {
  const rarity = card.rarity ?? '';
  if (/Secret|Rainbow|Hyper|Mega Hyper|Black White/i.test(rarity)) return 'secret';
  if (/Illustration|Trainer Gallery|Amazing|Radiant|Shiny|Classic/i.test(rarity)) return 'illustration';
  if (/Ultra|Double|EX|GX|VMAX|VSTAR|BREAK|Prime|LEGEND|ACE|Shining/i.test(rarity)) return 'ultra';
  return 'rare';
}

function randomFromPool(pool: Card[], used: Set<string>): Card {
  const available = pool.filter((card) => !used.has(card.id));
  const source = available.length > 0 ? available : pool;
  const card = source[Math.floor(Math.random() * source.length)];
  if (!card) {
    throw new Error('Booster pool is empty.');
  }
  used.add(card.id);
  return card;
}

function randomRare(used: Set<string>): Card {
  const weightedBuckets: Array<{ bucket: ReturnType<typeof rareBucket>; weight: number }> = [
    { bucket: 'rare', weight: 78 },
    { bucket: 'ultra', weight: 14 },
    { bucket: 'illustration', weight: 6 },
    { bucket: 'secret', weight: 2 },
  ];
  const roll = Math.random() * weightedBuckets.reduce((total, entry) => total + entry.weight, 0);
  let cursor = 0;
  for (const entry of weightedBuckets) {
    cursor += entry.weight;
    if (roll <= cursor) {
      const pool = BOOSTER_RARES.filter((card) => rareBucket(card) === entry.bucket);
      if (pool.length > 0) {
        return randomFromPool(pool, used);
      }
    }
  }
  return randomFromPool(BOOSTER_RARES, used);
}

function makeBoosterPack(): BoosterPull[] {
  const used = new Set<string>();
  return [
    ...Array.from({ length: 4 }, () => ({ card: randomFromPool(BOOSTER_COMMONS, used), slot: 'Common' as const })),
    ...Array.from({ length: 3 }, () => ({ card: randomFromPool(BOOSTER_UNCOMMONS, used), slot: 'Uncommon' as const })),
    { card: randomFromPool(BOOSTER_REVERSE.filter((card) => card.rarity === 'Common' || card.rarity === 'Uncommon'), used), slot: 'Reverse Holo' as const },
    { card: randomFromPool(BOOSTER_REVERSE, used), slot: 'Reverse Holo' as const },
    { card: randomRare(used), slot: 'Rare or better' as const },
    { card: randomFromPool(BOOSTER_ENERGY, used), slot: 'Basic Energy' as const },
  ];
}

function validateDeck(cards: string[]): string[] {
  const issues: string[] = [];
  if (cards.length !== DECK_SIZE) {
    issues.push(`Deck must be exactly ${DECK_SIZE} cards; it has ${cards.length}.`);
  }

  for (const [cardId, count] of Object.entries(deckCounts(cards))) {
    const card = CARD_LIBRARY[cardId];
    if (!card) {
      issues.push(`Unknown card: ${cardId}.`);
      continue;
    }
    if (card.kind !== 'energy' && count > MAX_CARD_COPIES) {
      issues.push(`${card.name} has ${count} copies; max is ${MAX_CARD_COPIES} unless it is Energy.`);
    }
  }

  if (!cards.some((cardId) => CARD_LIBRARY[cardId]?.kind === 'pokemon' && CARD_LIBRARY[cardId].stage === 'Basic')) {
    issues.push('Deck needs at least one Basic Pokemon.');
  }

  return issues;
}

function starterDeckOptions(): DeckOption[] {
  return STARTER_ENERGY_TYPES.map((type) => ({
    id: `starter:${type}`,
    label: `${type} Starter`,
    cardIds: STARTER_DECKS[type],
    issues: [],
  }));
}

function deckOptionsForProfile(profile: ProfileState): DeckOption[] {
  const customDecks = profile.deckLibrary.map((deck) => ({
    id: `custom:${deck.id}`,
    label: deck.name,
    cardIds: deck.cardIds,
    issues: validateDeck(deck.cardIds),
  }));
  return [...starterDeckOptions(), ...customDecks];
}

function firstValidDeckId(options: DeckOption[]): string {
  return options.find((option) => option.issues.length === 0)?.id ?? options[0]?.id ?? '';
}

function deckOptionById(options: DeckOption[], id: string): DeckOption | undefined {
  return options.find((option) => option.id === id) ?? options.find((option) => option.issues.length === 0) ?? options[0];
}

function asPlayerID(playerID: string): PlayerID {
  if (playerID === '0' || playerID === '1') {
    return playerID;
  }
  throw new Error(`Unexpected player ID from lobby: ${playerID}`);
}

function opponentID(playerID: PlayerID): PlayerID {
  return playerID === '0' ? '1' : '0';
}

function setupDataForMatch(match: LobbyAPI.Match): MatchSetupData | undefined {
  return match.setupData as MatchSetupData | undefined;
}

function playerInMatch(match: LobbyAPI.Match, playerID: PlayerID) {
  return match.players.find((player) => String(player.id) === playerID && Boolean(player.name));
}

function openSeat(match: LobbyAPI.Match): PlayerID | undefined {
  return PLAYER_IDS.find((playerID) => !playerInMatch(match, playerID));
}

function deckLabelForMatch(match: LobbyAPI.Match, playerID: PlayerID): string {
  return setupDataForMatch(match)?.deckLabels?.[playerID] ?? (playerID === '1' ? 'Opponent chooses on accept' : `Player ${playerID} deck`);
}

function matchNameForMatch(match: LobbyAPI.Match): string {
  return setupDataForMatch(match)?.matchName?.trim() || `Match ${match.matchID}`;
}

function matchTypeForMatch(match: LobbyAPI.Match): MatchType {
  return setupDataForMatch(match)?.matchType ?? 'Casual';
}

function Shell({
  page,
  profile,
  onNavigate,
  onLogout,
  children,
}: {
  page: Page;
  profile: ProfileState;
  onNavigate: (page: Page) => void;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <button className="brand-button" onClick={() => onNavigate('home')} aria-label="Go to home">
          <img className="brand-logo" src="/site-logo.png" alt="Pokemon Masters" />
        </button>
        <nav>
          {(['home', 'profile', 'matchmaking', 'boosters'] as Page[]).map((target) => (
            <button
              className={page === target ? 'nav-active' : ''}
              key={target}
              onClick={() => onNavigate(target)}
            >
              {target === 'matchmaking' ? 'Matchmaking' : target[0].toUpperCase() + target.slice(1)}
            </button>
          ))}
        </nav>
        <div className="account-pill">
          <span>{profile.wallet ? shortAddr(profile.wallet.address) : profile.name}</span>
          <button onClick={onLogout}>Sign out</button>
        </div>
      </header>
      {children}
    </div>
  );
}

function SignInPage({ onSignIn }: { onSignIn: (profile: ProfileState) => void }) {
  const [name, setName] = useState(() => loadProfile().name || 'PokemonTrainer');
  const [wallet, setWallet] = useState<ConnectedWallet | null>(() => loadProfile().wallet);
  const [error, setError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const solanaWallets = detectSolanaWallets();

  async function connect(kind: 'evm' | 'solana') {
    setError('');
    try {
      setWallet(kind === 'evm' ? await connectEvm() : await connectSolana());
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  async function finish() {
    setError('');
    setSigningIn(true);
    const profile = { ...DEFAULT_PROFILE, ...loadProfile(), name: name.trim() || 'PokemonTrainer', wallet };
    try {
      onSignIn(await loginAndStore(profile));
    } catch (err) {
      setError(`Could not load stored profile: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <main className="signin-page">
      <section className="signin-card">
        <img className="signin-logo" src="/site-logo.png" alt="Pokemon Masters" />
        <p className="eyebrow">Local wallet profile</p>
        <h1>Pokemon TCG Arena</h1>
        <p>Connect a browser wallet or continue with a trainer name. Your profile, collection, pack history, and match records are loaded from the game server.</p>
        <label>
          Trainer name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="wallet-actions">
          <button onClick={() => connect('evm')}>Connect EVM Wallet</button>
          <button onClick={() => connect('solana')}>Connect Solana Wallet</button>
        </div>
        <div className="wallet-list">
          {solanaWallets.map((walletInfo) => (
            <span key={walletInfo.kind}>{walletInfo.label}: {walletInfo.installed ? 'installed' : 'not found'}</span>
          ))}
        </div>
        {wallet && <p className="success">Connected {wallet.chain}: {shortAddr(wallet.address)}</p>}
        {error && <p className="error">{error}</p>}
        <button className="primary-cta" disabled={signingIn} onClick={finish}>
          {signingIn ? 'Loading profile...' : 'Enter Arena'}
        </button>
      </section>
    </main>
  );
}

function HomePage({ profile, onNavigate }: { profile: ProfileState; onNavigate: (page: Page) => void }) {
  return (
    <main className="hub-page">
      <section className="home-sidebar" aria-label="Home navigation">
        <div>
          <p className="eyebrow">Welcome back, {profile.name}</p>
          <h1>Choose your next adventure.</h1>
        </div>
        <div className="home-button-stack">
          <button className="home-menu-button primary-cta" onClick={() => onNavigate('matchmaking')}>
            <strong>Matchmaking</strong>
            <span>Create an online match or accept an open challenge.</span>
          </button>
          <button className="home-menu-button" onClick={() => onNavigate('profile')}>
            <strong>Profile + Deckbuilder</strong>
            <span>Manage your profile and custom deck library.</span>
          </button>
          <button className="home-menu-button" onClick={() => onNavigate('boosters')}>
            <strong>Boosters</strong>
            <span>Open packs for {PACK_PRICE_SOL} SOL and grow your collection.</span>
          </button>
        </div>
      </section>
    </main>
  );
}

function ProfilePage({ profile, onProfileChange }: { profile: ProfileState; onProfileChange: (profile: ProfileState) => void }) {
  const [name, setName] = useState(profile.name);
  const [deckName, setDeckName] = useState(profile.activeDeckName);
  const [deck, setDeck] = useState(profile.customDeck);
  const [deckLibrary, setDeckLibrary] = useState(profile.deckLibrary);
  const [editingDeckId, setEditingDeckId] = useState<string | null>(
    profile.deckLibrary.find((candidate) => candidate.name === profile.activeDeckName)?.id ?? null,
  );
  const [filter, setFilter] = useState<StarterEnergyType | 'all'>('all');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const issues = validateDeck(deck);
  const counts = deckCounts(deck);
  const visibleCards = BUILDABLE_CARDS.filter((card) =>
    (profile.ownedCards[card.id] ?? 0) > 0 &&
    (filter === 'all' || (card.kind === 'pokemon' && card.pokemonType === filter) || (card.kind === 'energy' && card.energyType === filter))
  );

  function updateDeck(cardId: string, delta: number) {
    const currentCount = counts[cardId] ?? 0;
    const card = CARD_LIBRARY[cardId];
    if (!card) return;
    const ownedCount = profile.ownedCards[cardId] ?? 0;
    if (delta > 0 && deck.length >= DECK_SIZE) return;
    if (delta > 0 && currentCount >= ownedCount) return;
    if (delta > 0 && card.kind !== 'energy' && currentCount >= MAX_CARD_COPIES) return;
    if (delta < 0 && currentCount <= 0) return;
    setDeck((current) => delta > 0 ? [...current, cardId] : current.filter((id, index) => id !== cardId || index !== current.indexOf(cardId)));
  }

  function newDeck() {
    setEditingDeckId(null);
    setDeckName('New Custom Deck');
    setDeck([]);
    setStatus('Started a blank custom deck.');
    setError('');
  }

  function loadDeck(deckEntry: CustomDeck) {
    setEditingDeckId(deckEntry.id);
    setDeckName(deckEntry.name);
    setDeck([...deckEntry.cardIds]);
    setStatus(`Loaded ${deckEntry.name}.`);
    setError('');
  }

  async function save() {
    setStatus('');
    setError('');
    const timestamp = new Date().toISOString();
    const existing = editingDeckId ? deckLibrary.find((candidate) => candidate.id === editingDeckId) : undefined;
    const savedDeck: CustomDeck = existing
      ? {
        ...existing,
        name: deckName.trim() || existing.name,
        cardIds: [...deck],
        updatedAt: timestamp,
      }
      : makeCustomDeck(deckName.trim() || 'Untitled Deck', deck);
    const nextLibrary = existing
      ? deckLibrary.map((candidate) => candidate.id === savedDeck.id ? savedDeck : candidate)
      : [...deckLibrary, savedDeck];
    const next = {
      ...profile,
      name: name.trim() || profile.name,
      activeDeckName: savedDeck.name,
      customDeck: savedDeck.cardIds,
      deckLibrary: nextLibrary,
    };
    try {
      const saved = await persistAndStore(next);
      onProfileChange(saved);
      setDeckLibrary(saved.deckLibrary);
      setEditingDeckId(savedDeck.id);
      setDeckName(savedDeck.name);
      setDeck([...savedDeck.cardIds]);
      setStatus(`${savedDeck.name} saved to your custom deck library.`);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <main className="content-page profile-page">
      <section className="panel profile-panel">
        <div>
          <p className="eyebrow">Trainer profile</p>
          <h1>{profile.name}</h1>
          <p>{profile.wallet ? `${profile.wallet.chain.toUpperCase()} ${shortAddr(profile.wallet.address)}` : 'No wallet connected'}</p>
        </div>
        <label>
          Display name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {status && <p className="success">{status}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel deckbuilder-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Deckbuilder</p>
            <h2>{deckName}</h2>
            <p className="section-subtitle">Collection: {collectionSize(profile.ownedCards)} cards / {Object.keys(profile.ownedCards).length} unique. Starter decks stay in matchmaking and cannot be edited here.</p>
          </div>
          <div className={issues.length === 0 ? 'deck-valid' : 'deck-invalid'}>{deck.length}/{DECK_SIZE}</div>
        </div>
        <section className="deck-library-section">
          <div className="deck-library-heading">
            <div>
              <h3>Custom deck library</h3>
              <p className="section-subtitle">Load a saved custom deck, or start a new blank deck from 0 cards.</p>
            </div>
            <button className="primary-cta" onClick={newDeck}>New deck</button>
          </div>
          {deckLibrary.length === 0 ? (
            <p className="action-hint">No custom decks saved yet. Click New deck, add cards, then save it to your library.</p>
          ) : (
            <div className="deck-library">
              {deckLibrary.map((deckEntry) => {
                const deckIssues = validateDeck(deckEntry.cardIds);
                return (
                  <article className={`deck-library-card ${editingDeckId === deckEntry.id ? 'deck-library-card-active' : ''}`} key={deckEntry.id}>
                    <div>
                      <strong>{deckEntry.name}</strong>
                      <span>{deckEntry.cardIds.length}/{DECK_SIZE} cards</span>
                      <span>{deckIssues.length === 0 ? 'Ready for matches' : `${deckIssues.length} issue${deckIssues.length === 1 ? '' : 's'}`}</span>
                    </div>
                    <button onClick={() => loadDeck(deckEntry)}>Load</button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <label>
          Deck name
          <input value={deckName} onChange={(event) => setDeckName(event.target.value)} />
        </label>
        {issues.length > 0 && (
          <ul className="issues">
            {issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        )}
        <div className="deckbuilder-layout">
          <aside className="deck-list">
            <h3>Current custom deck</h3>
            {Object.keys(counts).length === 0 ? (
              <p className="action-hint">This deck starts from 0 cards.</p>
            ) : (
              Object.entries(counts).map(([cardId, count]) => (
                <div key={cardId}>
                  <span>
                    {CARD_LIBRARY[cardId]?.images?.small && (
                      <img alt="" className="deck-list-thumb" loading="lazy" src={CARD_LIBRARY[cardId].images.small} />
                    )}
                    {CARD_LIBRARY[cardId]?.name ?? cardId}
                  </span>
                  <strong>x{count}</strong>
                </div>
              ))
            )}
          </aside>
          <div className="card-pool">
            <div className="filters">
              <button className={filter === 'all' ? 'nav-active' : ''} onClick={() => setFilter('all')}>All</button>
              {STARTER_ENERGY_TYPES.map((type) => (
                <button className={filter === type ? 'nav-active' : ''} key={type} onClick={() => setFilter(type)}>{type}</button>
              ))}
            </div>
            <div className="card-pool-grid">
              {visibleCards.map((card) => {
                const count = counts[card.id] ?? 0;
                const ownedCount = profile.ownedCards[card.id] ?? 0;
                const maxAllowed = card.kind === 'energy' ? ownedCount : Math.min(ownedCount, MAX_CARD_COPIES);
                const canAdd = deck.length < DECK_SIZE && count < maxAllowed;
                return (
                  <article className={`builder-card ${count ? 'builder-card-owned' : ''}`} key={card.id} tabIndex={0}>
                    <DeckbuilderCardArt card={card} />
                    <div className="builder-card-copy-count">x{count}</div>
                    <div className="builder-card-info">
                      <strong>{card.name}</strong>
                      <span>{cardLabel(card)}</span>
                      <span>Owned: {ownedCount} / usable: {maxAllowed}</span>
                    </div>
                    <div className="builder-card-controls">
                      <button disabled={count <= 0} onClick={() => updateDeck(card.id, -1)}>-</button>
                      <span>{count}</span>
                      <button disabled={!canAdd} onClick={() => updateDeck(card.id, 1)}>+</button>
                    </div>
                  </article>
                );
              })}
              {visibleCards.length === 0 && (
                <p className="action-hint">No owned cards match this filter. Open boosters or choose another type.</p>
              )}
            </div>
          </div>
        </div>
        <button className="primary-cta" onClick={save} disabled={!deckName.trim()}>Save deck to library</button>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Match records</p>
            <h2>{profile.matchRecords.length} saved match{profile.matchRecords.length === 1 ? '' : 'es'}</h2>
          </div>
        </div>
        {profile.matchRecords.length === 0 ? (
          <p>No matches recorded yet.</p>
        ) : (
          <div className="match-list">
            {[...profile.matchRecords].reverse().map((record) => (
              <article className="match-card" key={`${record.matchID}-${record.playerID}`}>
                <div>
                  <strong>{record.result.replace('_', ' ').toUpperCase()} - Match {record.matchID}</strong>
                  <span>Player {record.playerID}: {record.playerDeckLabel} vs {record.opponentDeckLabel}</span>
                  <span>{record.completedAt ? `Completed ${new Date(record.completedAt).toLocaleString()}` : `Started ${new Date(record.startedAt).toLocaleString()}`}</span>
                  {record.reason && <span>{record.reason}</span>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function MatchmakingPage({
  onProfileChange,
  profile,
  onStartMatch,
}: {
  onProfileChange: (profile: ProfileState) => void;
  profile: ProfileState;
  onStartMatch: (config: MatchConfig) => void;
}) {
  const deckOptions = useMemo(() => deckOptionsForProfile(profile), [profile]);
  const [playerDeckId, setPlayerDeckId] = useState(() => firstValidDeckId(deckOptionsForProfile(profile)));
  const [acceptDeckId, setAcceptDeckId] = useState(() => firstValidDeckId(deckOptionsForProfile(profile)));
  const [matchName, setMatchName] = useState(`${profile.name}'s Match`);
  const [matchType, setMatchType] = useState<MatchType>('Casual');
  const [matches, setMatches] = useState<LobbyAPI.Match[]>([]);
  const [leaderboard, setLeaderboard] = useState<MatchLeaderboardEntry[]>([]);
  const [busy, setBusy] = useState<'create' | 'refresh' | string | null>(null);
  const [error, setError] = useState('');
  const lobby = useMemo(() => new LobbyClient({ server: MULTIPLAYER_SERVER }), []);
  const selectedPlayerDeck = deckOptionById(deckOptions, playerDeckId);
  const selectedAcceptDeck = deckOptionById(deckOptions, acceptDeckId);

  useEffect(() => {
    if (!deckOptions.some((option) => option.id === playerDeckId)) {
      setPlayerDeckId(firstValidDeckId(deckOptions));
    }
    if (!deckOptions.some((option) => option.id === acceptDeckId)) {
      setAcceptDeckId(firstValidDeckId(deckOptions));
    }
  }, [acceptDeckId, deckOptions, playerDeckId]);

  async function refreshMatches() {
    setError('');
    setBusy('refresh');
    try {
      const [{ matches: listedMatches }, leaderboardRows] = await Promise.all([
        lobby.listMatches(GAME_NAME, { isGameover: false }),
        fetchLeaderboard(),
      ]);
      setMatches(listedMatches.filter((match) => Boolean(openSeat(match))));
      setLeaderboard(leaderboardRows);
    } catch (err) {
      setError(`Could not reach multiplayer server at ${MULTIPLAYER_SERVER}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void refreshMatches();
  }, []);

  async function recordStartedMatch(config: MatchConfig): Promise<void> {
    const record: MatchRecord = {
      matchID: config.matchID,
      playerID: config.playerID,
      playerDeckLabel: config.playerDeckLabel,
      opponentDeckLabel: config.opponentDeckLabel,
      result: 'in_progress',
      startedAt: new Date().toISOString(),
    };
    onProfileChange(await persistMatchAndStore(profile, record));
  }

  async function createMatch() {
    if (!selectedPlayerDeck) {
      setError('Choose your deck before creating a match.');
      return;
    }
    if (selectedPlayerDeck.issues.length > 0) {
      setError(`${selectedPlayerDeck.label} cannot be used yet: ${selectedPlayerDeck.issues.join(' ')}`);
      return;
    }

    const cleanMatchName = matchName.trim() || `${profile.name}'s ${matchType} Match`;
    const deckLabels: Partial<Record<PlayerID, string>> = {
      '0': selectedPlayerDeck.label,
    };
    const setupData: MatchSetupData = {
      matchName: cleanMatchName,
      matchType,
      seedDecks: {
        '0': selectedPlayerDeck.cardIds,
      },
      deckLabels,
    };

    setError('');
    setBusy('create');
    try {
      const { matchID } = await lobby.createMatch(GAME_NAME, {
        numPlayers: 2,
        setupData,
      });
      const joined = await lobby.joinMatch(GAME_NAME, matchID, {
        playerID: '0',
        playerName: profile.name,
        data: { deckLabel: selectedPlayerDeck.label },
      });
      const playerID = asPlayerID(joined.playerID);
      const config = {
        matchID,
        matchName: cleanMatchName,
        matchType,
        playerID,
        credentials: joined.playerCredentials,
        playerDeckLabel: selectedPlayerDeck.label,
        opponentDeckLabel: 'Opponent chooses on accept',
        server: MULTIPLAYER_SERVER,
      };
      await recordStartedMatch(config);
      onStartMatch(config);
    } catch (err) {
      setError(`Could not create match: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function acceptMatch(match: LobbyAPI.Match) {
    const seat = openSeat(match);
    if (!seat) {
      setError('That match is already full. Refresh the list and try another one.');
      return;
    }
    if (!selectedAcceptDeck) {
      setError('Choose a deck before accepting a match.');
      return;
    }
    if (selectedAcceptDeck.issues.length > 0) {
      setError(`${selectedAcceptDeck.label} cannot be used yet: ${selectedAcceptDeck.issues.join(' ')}`);
      return;
    }

    setError('');
    setBusy(match.matchID);
    try {
      const joined = await lobby.joinMatch(GAME_NAME, match.matchID, {
        playerID: seat,
        playerName: profile.name,
        data: { deckLabel: selectedAcceptDeck.label },
      });
      const playerID = asPlayerID(joined.playerID);
      const config = {
        matchID: match.matchID,
        matchName: matchNameForMatch(match),
        matchType: matchTypeForMatch(match),
        playerDeck: {
          cardIds: selectedAcceptDeck.cardIds,
          label: selectedAcceptDeck.label,
        },
        playerID,
        credentials: joined.playerCredentials,
        playerDeckLabel: selectedAcceptDeck.label,
        opponentDeckLabel: deckLabelForMatch(match, opponentID(playerID)),
        server: MULTIPLAYER_SERVER,
      };
      await recordStartedMatch(config);
      onStartMatch(config);
    } catch (err) {
      setError(`Could not join match: ${err instanceof Error ? err.message : String(err)}`);
      await refreshMatches();
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="content-page matchmaking-page">
      <section className="panel matchmaking-center-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Matchmaking</p>
            <h1>Available matches</h1>
          </div>
          <button disabled={busy !== null} onClick={refreshMatches}>
            {busy === 'refresh' ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <div className="matchmaking-controls">
          <div className="matchmaking-create-controls">
            <label className="match-name-field">
              Match name
              <input value={matchName} onChange={(event) => setMatchName(event.target.value)} placeholder={`${profile.name}'s Match`} />
            </label>
            <label className="deck-select">
              Match type
              <select value={matchType} onChange={(event) => setMatchType(event.target.value as MatchType)}>
                {MATCH_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <DeckSelect title="Start as" value={playerDeckId} options={deckOptions} onChange={setPlayerDeckId} />
            <button className="primary-cta" disabled={busy !== null || !selectedPlayerDeck || selectedPlayerDeck.issues.length > 0} onClick={createMatch}>
              {busy === 'create' ? 'Creating...' : 'Create match'}
            </button>
          </div>
          <DeckSelect title="Accept as" value={acceptDeckId} options={deckOptions} onChange={setAcceptDeckId} />
        </div>
        {error && <p className="error">{error}</p>}
        {matches.length === 0 ? (
          <p className="empty-state">No open matches yet. Create one, or have another player create one and refresh.</p>
        ) : (
          <div className="match-list">
            {matches.map((match) => {
              const seat = openSeat(match);
              const creator = playerInMatch(match, '0')?.name ?? 'Waiting for creator';
              const acceptor = playerInMatch(match, '1')?.name ?? 'Open seat';
              const canAcceptSelectedDeck = Boolean(seat && selectedAcceptDeck && selectedAcceptDeck.issues.length === 0);
              return (
                <article className="match-card" key={match.matchID}>
                  <div>
                    <strong>{matchNameForMatch(match)}</strong>
                    <span>{matchTypeForMatch(match)} - Match {match.matchID}</span>
                    <span>Player 0: {creator} using {deckLabelForMatch(match, '0')}</span>
                    <span>Player 1: {acceptor} - chooses their own deck when accepting</span>
                  </div>
                  <button disabled={busy !== null || !canAcceptSelectedDeck} onClick={() => acceptMatch(match)}>
                    {busy === match.matchID ? 'Joining...' : 'Accept match'}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel leaderboard-panel">
        <div>
          <p className="eyebrow">Leaderboard</p>
          <h2>Wins / losses for all players</h2>
        </div>
        {leaderboard.length === 0 ? (
          <p className="empty-state">No player records yet.</p>
        ) : (
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Player</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Draws</th>
                <th>Matches</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((entry, index) => (
                <tr key={entry.userId}>
                  <td>{index + 1}</td>
                  <td>{entry.name}</td>
                  <td>{entry.wins}</td>
                  <td>{entry.losses}</td>
                  <td>{entry.draws}</td>
                  <td>{entry.matches}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function DeckSelect({
  title,
  value,
  options,
  onChange,
}: {
  title: string;
  value: string;
  options: DeckOption[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="deck-select">
      {title}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option disabled={option.issues.length > 0} key={option.id} value={option.id}>
            {option.label}{option.issues.length > 0 ? ' (fix deck)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function BoostersPage({ profile, onProfileChange }: { profile: ProfileState; onProfileChange: (profile: ProfileState) => void }) {
  const [pack, setPack] = useState<BoosterPull[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [buying, setBuying] = useState(false);

  async function buyPack() {
    setStatus('');
    setError('');
    if (profile.wallet?.chain !== 'solana') {
      setError('Connect a Solana wallet on sign-in before buying booster packs.');
      return;
    }
    if (!PACK_PAYMENT_RECIPIENT) {
      setError('Pack payments are not configured. Set VITE_PACK_PAYMENT_RECIPIENT to the recipient Solana address.');
      return;
    }

    setBuying(true);
    try {
      const { sendSolPayment } = await import('./walletPayment');
      const signature = await sendSolPayment({
        payerAddress: profile.wallet.address,
        recipientAddress: PACK_PAYMENT_RECIPIENT,
        amountSol: PACK_PRICE_SOL,
        rpcUrl: SOLANA_RPC_URL,
      });
      const next = makeBoosterPack();
      const cardIds = next.map(({ card }) => card.id);
      const purchase = { signature, openedAt: new Date().toISOString(), cardIds };
      const updated = {
        ...profile,
        ownedCards: addCardsToCollection(profile.ownedCards, cardIds),
        packsOpened: profile.packsOpened + 1,
        packPurchases: [
          ...profile.packPurchases,
          purchase,
        ],
      };
      const saved = await persistPackAndStore(updated, purchase);
      onProfileChange(saved);
      setPack(next);
      setStatus(`Pack opened and ${cardIds.length} cards added to your collection. Signature: ${signature.slice(0, 8)}...${signature.slice(-8)}`);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBuying(false);
    }
  }

  return (
    <main className="content-page">
      <section className="panel boosters-panel">
        <p className="eyebrow">Boosters</p>
        <h1>Buy Pokemon-style boosters</h1>
        <p>Each pack costs {PACK_PRICE_SOL} SOL, then adds its pulls to your deckbuilder collection. Pack collation uses a Scarlet & Violet-style mix: 4 Commons, 3 Uncommons, 2 Reverse Holo slots, 1 Rare-or-better slot, and 1 Basic Energy.</p>
        <div className={`booster-pack ${buying ? 'booster-pack-busy' : ''}`} onClick={buying ? undefined : buyPack}>
          <strong>Pokemon Booster</strong>
          <span>{buying ? 'Confirming payment...' : `${PACK_PRICE_SOL} SOL - click to buy`}</span>
        </div>
        <p>Recipient: {PACK_PAYMENT_RECIPIENT ? shortAddr(PACK_PAYMENT_RECIPIENT) : 'not configured'}</p>
        <p>Packs opened: {profile.packsOpened}</p>
        <p>Collection: {collectionSize(profile.ownedCards)} cards / {Object.keys(profile.ownedCards).length} unique</p>
        {status && <p className="success">{status}</p>}
        {error && <p className="error">{error}</p>}
      </section>
      {pack.length > 0 && (
        <section className="booster-grid">
          {pack.map(({ card, slot }, index) => (
            <article className="booster-card" key={`${card.id}-${index}`}>
              <DeckbuilderCardArt card={card} />
              <strong>{card.name}</strong>
              <span>{cardLabel(card)}</span>
              <span>{slot} - {card.rarity ?? 'No rarity'}</span>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

function MatchClient({
  config,
  onExit,
  onProfileChange,
  profile,
}: {
  config: MatchConfig;
  onExit: () => void;
  onProfileChange: (profile: ProfileState) => void;
  profile: ProfileState;
}) {
  const [recordedGameover, setRecordedGameover] = useState(false);
  const recordMatchCompletion = useCallback(async ({ reason, winner }: { reason?: string; winner?: PlayerID }) => {
    if (recordedGameover) {
      return;
    }
    setRecordedGameover(true);
    const result = winner === undefined
      ? 'draw'
      : winner === config.playerID
        ? 'win'
        : 'loss';
    const startedRecord = profile.matchRecords.find((record) => record.matchID === config.matchID && record.playerID === config.playerID);
    const record: MatchRecord = {
      matchID: config.matchID,
      playerID: config.playerID,
      playerDeckLabel: config.playerDeckLabel,
      opponentDeckLabel: config.opponentDeckLabel,
      result,
      winner,
      reason,
      startedAt: startedRecord?.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    onProfileChange(await persistMatchAndStore(profile, record));
  }, [config.matchID, config.opponentDeckLabel, config.playerDeckLabel, config.playerID, onProfileChange, profile, recordedGameover]);

  const MatchBoard = useMemo(() => (
    function MatchBoard(props: BoardProps<PokemonTCGState>) {
      return <PokemonBoard {...props} onMatchComplete={recordMatchCompletion} selectedDeck={config.playerDeck} />;
    }
  ), [config.playerDeck, recordMatchCompletion]);

  const PokemonClient = useMemo(() => {
    return Client({
      game: PokemonTCG,
      board: MatchBoard,
      numPlayers: 2,
      multiplayer: SocketIO({ server: config.server }),
      loading: () => <div className="match-loading">Connecting to multiplayer match...</div>,
      debug: false,
    });
  }, [MatchBoard, config.server]);

  return (
    <div className="match-screen">
      <div className="viewer-switch">
        <button onClick={onExit}>Exit match</button>
        <span>{config.matchName} ({config.matchType})</span>
        <span>Match {config.matchID}</span>
        <span>You are Player {config.playerID}: {config.playerDeckLabel} vs {config.opponentDeckLabel}</span>
      </div>
      <PokemonClient
        credentials={config.credentials}
        matchID={config.matchID}
        playerID={config.playerID}
      />
    </div>
  );
}

export default function App() {
  const [profile, setProfile] = useState<ProfileState>(() => loadProfile());
  const [page, setPage] = useState<Page>(() => (loadProfile().name ? 'home' : 'signin'));
  const [matchConfig, setMatchConfig] = useState<MatchConfig | null>(null);

  function updateProfile(next: ProfileState) {
    setProfile(next);
    saveProfile(next);
  }

  function signOut() {
    setProfile(DEFAULT_PROFILE);
    localStorage.removeItem(PROFILE_KEY);
    setMatchConfig(null);
    setPage('signin');
  }

  if (page === 'signin' || !profile.name) {
    return <SignInPage onSignIn={(next) => { setProfile(next); setPage('home'); }} />;
  }

  if (page === 'match' && matchConfig) {
    return (
      <MatchClient
        config={matchConfig}
        onExit={() => { setMatchConfig(null); setPage('home'); }}
        onProfileChange={updateProfile}
        profile={profile}
      />
    );
  }

  return (
    <Shell page={page} profile={profile} onNavigate={setPage} onLogout={signOut}>
      {page === 'profile' && <ProfilePage profile={profile} onProfileChange={updateProfile} />}
      {page === 'matchmaking' && (
        <MatchmakingPage
          onProfileChange={updateProfile}
          profile={profile}
          onStartMatch={(config) => {
            setMatchConfig(config);
            setPage('match');
          }}
        />
      )}
      {page === 'boosters' && <BoostersPage profile={profile} onProfileChange={updateProfile} />}
      {page === 'home' && <HomePage profile={profile} onNavigate={setPage} />}
    </Shell>
  );
}
