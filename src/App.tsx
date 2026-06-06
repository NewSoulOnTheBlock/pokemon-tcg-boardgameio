import { useEffect, useMemo, useState } from 'react';
import type { LobbyAPI } from 'boardgame.io';
import { LobbyClient } from 'boardgame.io/client';
import { Client } from 'boardgame.io/react';
import { SocketIO } from 'boardgame.io/multiplayer';
import {
  CARD_LIBRARY,
  ENERGY_TYPE_META,
  STARTER_DECKS,
  STARTER_ENERGY_TYPES,
  type StarterEnergyType,
} from './game/cards';
import { PokemonTCG } from './game/PokemonTCG';
import type { Card, PlayerID, PokemonTCGSetupData } from './game/types';
import { PokemonBoard } from './PokemonBoard';
import {
  connectEvm,
  connectSolana,
  detectSolanaWallets,
  sendSolPayment,
  shortAddr,
  type ConnectedWallet,
} from './wallet';

type Page = 'signin' | 'home' | 'profile' | 'matchmaking' | 'boosters' | 'match';

interface ProfileState {
  name: string;
  wallet: ConnectedWallet | null;
  activeDeckName: string;
  customDeck: string[];
  ownedCards: Record<string, number>;
  packsOpened: number;
  packPurchases: Array<{
    signature: string;
    openedAt: string;
    cardIds: string[];
  }>;
}

interface MatchConfig {
  matchID: string;
  playerID: PlayerID;
  credentials: string;
  playerDeckLabel: string;
  opponentDeckLabel: string;
  server: string;
}

interface MatchSetupData extends PokemonTCGSetupData {
  deckLabels?: Record<PlayerID, string>;
}

const PROFILE_KEY = 'pokemon-tcg-profile';
const DECK_SIZE = 60;
const MAX_CARD_COPIES = 4;
const PACK_PRICE_SOL = 0.1;
const PACK_PAYMENT_RECIPIENT = import.meta.env.VITE_PACK_PAYMENT_RECIPIENT?.trim() ?? '';
const SOLANA_RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const GAME_NAME = PokemonTCG.name ?? 'pokemon-tcg';
const MULTIPLAYER_SERVER = import.meta.env.VITE_BGIO_SERVER || `${window.location.protocol}//${window.location.hostname}:8000`;
const PLAYER_IDS: PlayerID[] = ['0', '1'];
const STARTER_COLLECTION = collectionFromCards(Object.values(STARTER_DECKS).flat());
const DEFAULT_PROFILE: ProfileState = {
  name: '',
  wallet: null,
  activeDeckName: 'Grass Starter',
  customDeck: STARTER_DECKS.Grass,
  ownedCards: STARTER_COLLECTION,
  packsOpened: 0,
  packPurchases: [],
};

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
      return { ...DEFAULT_PROFILE, ownedCards: { ...DEFAULT_PROFILE.ownedCards }, customDeck: [...DEFAULT_PROFILE.customDeck] };
    }

    const parsed = JSON.parse(stored) as Partial<ProfileState>;
    const customDeck = Array.isArray(parsed.customDeck) ? parsed.customDeck : DEFAULT_PROFILE.customDeck;
    return {
      ...DEFAULT_PROFILE,
      ...parsed,
      customDeck,
      ownedCards: maxCollections(STARTER_COLLECTION, parsed.ownedCards ?? {}, collectionFromCards(customDeck)),
      packPurchases: Array.isArray(parsed.packPurchases) ? parsed.packPurchases : [],
    };
  } catch {
    return { ...DEFAULT_PROFILE, ownedCards: { ...DEFAULT_PROFILE.ownedCards }, customDeck: [...DEFAULT_PROFILE.customDeck] };
  }
}

function saveProfile(profile: ProfileState): void {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function cardLabel(card: Card): string {
  if (card.kind === 'pokemon') return `${card.name} - ${card.stage} ${card.pokemonType}`;
  if (card.kind === 'energy') return `${card.name} - ${card.energyType}`;
  return `${card.name} - ${card.trainerType}`;
}

function collectionFromCards(cards: string[]): Record<string, number> {
  return cards.reduce<Record<string, number>>((counts, cardId) => {
    counts[cardId] = (counts[cardId] ?? 0) + 1;
    return counts;
  }, {});
}

function addCardsToCollection(collection: Record<string, number>, cardIds: string[]): Record<string, number> {
  const next = { ...collection };
  for (const cardId of cardIds) {
    next[cardId] = (next[cardId] ?? 0) + 1;
  }
  return next;
}

function maxCollections(...collections: Array<Record<string, number>>): Record<string, number> {
  const next: Record<string, number> = {};
  for (const collection of collections) {
    for (const [cardId, count] of Object.entries(collection)) {
      next[cardId] = Math.max(next[cardId] ?? 0, count);
    }
  }
  return next;
}

function collectionSize(collection: Record<string, number>): number {
  return Object.values(collection).reduce((total, count) => total + count, 0);
}

function DeckbuilderCardArt({ card }: { card: Card }) {
  const thumbnail = card.images?.small ?? card.images?.large;
  const preview = card.images?.large ?? card.images?.small;

  if (!thumbnail) {
    return (
      <div className="builder-card-art builder-card-art-placeholder" aria-label={card.name}>
        <strong>{card.name}</strong>
        <span>{card.kind}</span>
      </div>
    );
  }

  return (
    <div className="builder-card-art">
      <img src={thumbnail} alt={card.name} loading="lazy" decoding="async" />
      {preview && (
        <div className="builder-card-hover-preview" aria-hidden="true">
          <img src={preview} alt="" loading="lazy" decoding="async" />
        </div>
      )}
    </div>
  );
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
  return setupDataForMatch(match)?.deckLabels?.[playerID] ?? `Player ${playerID} deck`;
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
        <button className="brand-button" onClick={() => onNavigate('home')}>Pokemon TCG</button>
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
  const solanaWallets = detectSolanaWallets();

  async function connect(kind: 'evm' | 'solana') {
    setError('');
    try {
      setWallet(kind === 'evm' ? await connectEvm() : await connectSolana());
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  function finish() {
    const profile = { ...DEFAULT_PROFILE, ...loadProfile(), name: name.trim() || 'PokemonTrainer', wallet };
    saveProfile(profile);
    onSignIn(profile);
  }

  return (
    <main className="signin-page">
      <section className="signin-card">
        <p className="eyebrow">Local wallet profile</p>
        <h1>Pokemon TCG Arena</h1>
        <p>Connect a browser wallet or continue with a trainer name. The profile, deckbuilder, packs, and selected decks are stored locally.</p>
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
        <button className="primary-cta" onClick={finish}>Enter Arena</button>
      </section>
    </main>
  );
}

function HomePage({ profile, onNavigate }: { profile: ProfileState; onNavigate: (page: Page) => void }) {
  return (
    <main className="hub-page">
      <section className="hub-hero">
        <div>
          <p className="eyebrow">Welcome back, {profile.name}</p>
          <h1>Build decks, crack packs, and queue into a match.</h1>
          <p>Mirrors the Memetic Masters flow: home hub, profile deckbuilder, matchmaking, boosters, then a boardgame.io match.</p>
        </div>
        <button className="primary-cta" onClick={() => onNavigate('matchmaking')}>Play now</button>
      </section>
      <section className="hub-grid">
        <button className="hub-tile" onClick={() => onNavigate('matchmaking')}>
          <strong>Matchmaking</strong>
          <span>Create an online match or accept an open challenge.</span>
        </button>
        <button className="hub-tile" onClick={() => onNavigate('profile')}>
          <strong>Profile + Deckbuilder</strong>
          <span>Manage your wallet profile and custom 60-card deck.</span>
        </button>
        <button className="hub-tile" onClick={() => onNavigate('boosters')}>
          <strong>Boosters</strong>
          <span>Buy packs for {PACK_PRICE_SOL} SOL and add pulls to your collection.</span>
        </button>
      </section>
    </main>
  );
}

function ProfilePage({ profile, onProfileChange }: { profile: ProfileState; onProfileChange: (profile: ProfileState) => void }) {
  const [name, setName] = useState(profile.name);
  const [deckName, setDeckName] = useState(profile.activeDeckName);
  const [deck, setDeck] = useState(profile.customDeck);
  const [filter, setFilter] = useState<StarterEnergyType | 'all'>('all');
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

  function useStarter(type: StarterEnergyType) {
    setDeck([...STARTER_DECKS[type]]);
    setDeckName(`${type} Starter`);
    setFilter(type);
  }

  function save() {
    const next = { ...profile, name: name.trim() || profile.name, activeDeckName: deckName.trim() || 'Custom Deck', customDeck: deck };
    saveProfile(next);
    onProfileChange(next);
  }

  return (
    <main className="content-page">
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
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Deckbuilder</p>
            <h2>{deckName}</h2>
            <p className="section-subtitle">Collection: {collectionSize(profile.ownedCards)} cards / {Object.keys(profile.ownedCards).length} unique. Booster pulls unlock more usable cards here.</p>
          </div>
          <div className={issues.length === 0 ? 'deck-valid' : 'deck-invalid'}>{deck.length}/{DECK_SIZE}</div>
        </div>
        <label>
          Deck name
          <input value={deckName} onChange={(event) => setDeckName(event.target.value)} />
        </label>
        <div className="starter-row">
          {STARTER_ENERGY_TYPES.map((type) => (
            <button key={type} onClick={() => useStarter(type)} style={{ '--energy': ENERGY_TYPE_META[type].hex } as React.CSSProperties}>
              {type}
            </button>
          ))}
        </div>
        {issues.length > 0 && (
          <ul className="issues">
            {issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        )}
        <div className="deckbuilder-layout">
          <aside className="deck-list">
            {Object.entries(counts).map(([cardId, count]) => (
              <div key={cardId}>
                <span>
                  {CARD_LIBRARY[cardId]?.images?.small && (
                    <img alt="" className="deck-list-thumb" loading="lazy" src={CARD_LIBRARY[cardId].images.small} />
                  )}
                  {CARD_LIBRARY[cardId]?.name ?? cardId}
                </span>
                <strong>x{count}</strong>
              </div>
            ))}
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
        <button className="primary-cta" onClick={save} disabled={issues.length > 0}>Save active deck</button>
      </section>
    </main>
  );
}

function MatchmakingPage({
  profile,
  onStartMatch,
}: {
  profile: ProfileState;
  onStartMatch: (config: MatchConfig) => void;
}) {
  const [playerDeckType, setPlayerDeckType] = useState<StarterEnergyType>('Grass');
  const [opponentDeckType, setOpponentDeckType] = useState<StarterEnergyType>('Fire');
  const [useCustomDeck, setUseCustomDeck] = useState(false);
  const [matches, setMatches] = useState<LobbyAPI.Match[]>([]);
  const [busy, setBusy] = useState<'create' | 'refresh' | string | null>(null);
  const [error, setError] = useState('');
  const lobby = useMemo(() => new LobbyClient({ server: MULTIPLAYER_SERVER }), []);
  const customIssues = validateDeck(profile.customDeck);

  async function refreshMatches() {
    setError('');
    setBusy('refresh');
    try {
      const { matches: listedMatches } = await lobby.listMatches(GAME_NAME, { isGameover: false });
      setMatches(listedMatches.filter((match) => Boolean(openSeat(match))));
    } catch (err) {
      setError(`Could not reach multiplayer server at ${MULTIPLAYER_SERVER}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void refreshMatches();
  }, []);

  async function createMatch() {
    const playerDeck = useCustomDeck ? profile.customDeck : STARTER_DECKS[playerDeckType];
    const playerDeckLabel = useCustomDeck ? profile.activeDeckName : `${playerDeckType} Starter`;
    const opponentDeckLabel = `${opponentDeckType} Starter`;
    const deckLabels: Record<PlayerID, string> = {
      '0': playerDeckLabel,
      '1': opponentDeckLabel,
    };
    const setupData: MatchSetupData = {
      seedDecks: {
        '0': playerDeck,
        '1': STARTER_DECKS[opponentDeckType],
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
        data: { deckLabel: playerDeckLabel },
      });
      const playerID = asPlayerID(joined.playerID);
      onStartMatch({
        matchID,
        playerID,
        credentials: joined.playerCredentials,
        playerDeckLabel: deckLabels[playerID],
        opponentDeckLabel: deckLabels[opponentID(playerID)],
        server: MULTIPLAYER_SERVER,
      });
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

    setError('');
    setBusy(match.matchID);
    try {
      const joined = await lobby.joinMatch(GAME_NAME, match.matchID, {
        playerID: seat,
        playerName: profile.name,
        data: { deckLabel: deckLabelForMatch(match, seat) },
      });
      const playerID = asPlayerID(joined.playerID);
      onStartMatch({
        matchID: match.matchID,
        playerID,
        credentials: joined.playerCredentials,
        playerDeckLabel: deckLabelForMatch(match, playerID),
        opponentDeckLabel: deckLabelForMatch(match, opponentID(playerID)),
        server: MULTIPLAYER_SERVER,
      });
    } catch (err) {
      setError(`Could not join match: ${err instanceof Error ? err.message : String(err)}`);
      await refreshMatches();
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="content-page">
      <section className="panel">
        <p className="eyebrow">Matchmaking</p>
        <h1>Create a match or accept a challenge</h1>
        <p>Network matchmaking uses the boardgame.io lobby server at <strong>{MULTIPLAYER_SERVER}</strong>. The creator seeds both decks, joins as Player 0, and the acceptor joins as Player 1.</p>
        <label className="checkbox-row">
          <input
            checked={useCustomDeck}
            disabled={customIssues.length > 0}
            onChange={(event) => setUseCustomDeck(event.target.checked)}
            type="checkbox"
          />
          Use saved profile deck ({profile.activeDeckName})
        </label>
        <DeckChoice title="Your starter deck" value={playerDeckType} onChange={setPlayerDeckType} disabled={useCustomDeck} />
        <DeckChoice title="Acceptor starter deck" value={opponentDeckType} onChange={setOpponentDeckType} />
        <button className="primary-cta" disabled={busy !== null} onClick={createMatch}>
          {busy === 'create' ? 'Creating match...' : 'Create online match'}
        </button>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Open challenges</p>
            <h2>Accept someone else's match</h2>
          </div>
          <button disabled={busy !== null} onClick={refreshMatches}>
            {busy === 'refresh' ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        {matches.length === 0 ? (
          <p>No open matches yet. Create one here, or have another player create one and refresh.</p>
        ) : (
          <div className="match-list">
            {matches.map((match) => {
              const creator = playerInMatch(match, '0')?.name ?? 'Waiting for creator';
              const acceptor = playerInMatch(match, '1')?.name ?? 'Open seat';
              return (
                <article className="match-card" key={match.matchID}>
                  <div>
                    <strong>{deckLabelForMatch(match, '0')} vs {deckLabelForMatch(match, '1')}</strong>
                    <span>Match {match.matchID}</span>
                    <span>Player 0: {creator} | Player 1: {acceptor}</span>
                  </div>
                  <button disabled={busy !== null} onClick={() => acceptMatch(match)}>
                    {busy === match.matchID ? 'Joining...' : 'Accept match'}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

function DeckChoice({
  title,
  value,
  disabled = false,
  onChange,
}: {
  title: string;
  value: StarterEnergyType;
  disabled?: boolean;
  onChange: (type: StarterEnergyType) => void;
}) {
  return (
    <section className="deck-choice">
      <h2>{title}</h2>
      <div className="starter-grid">
        {STARTER_ENERGY_TYPES.map((type) => (
          <button
            className={value === type ? 'starter-selected' : ''}
            disabled={disabled}
            key={type}
            onClick={() => onChange(type)}
            style={{ '--energy': ENERGY_TYPE_META[type].hex, '--ink': ENERGY_TYPE_META[type].ink } as React.CSSProperties}
          >
            <strong>{type}</strong>
            <span>{ENERGY_TYPE_META[type].description}</span>
          </button>
        ))}
      </div>
    </section>
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
      const signature = await sendSolPayment({
        payerAddress: profile.wallet.address,
        recipientAddress: PACK_PAYMENT_RECIPIENT,
        amountSol: PACK_PRICE_SOL,
        rpcUrl: SOLANA_RPC_URL,
      });
      const next = makeBoosterPack();
      const cardIds = next.map(({ card }) => card.id);
      const updated = {
        ...profile,
        ownedCards: addCardsToCollection(profile.ownedCards, cardIds),
        packsOpened: profile.packsOpened + 1,
        packPurchases: [
          ...profile.packPurchases,
          { signature, openedAt: new Date().toISOString(), cardIds },
        ],
      };
      saveProfile(updated);
      onProfileChange(updated);
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

function MatchClient({ config, onExit }: { config: MatchConfig; onExit: () => void }) {
  const PokemonClient = useMemo(() => {
    return Client({
      game: PokemonTCG,
      board: PokemonBoard,
      numPlayers: 2,
      multiplayer: SocketIO({ server: config.server }),
      loading: () => <div className="match-loading">Connecting to multiplayer match...</div>,
      debug: false,
    });
  }, [config.server]);

  return (
    <div className="match-screen">
      <div className="viewer-switch">
        <button onClick={onExit}>Exit match</button>
        <span>Match {config.matchID}</span>
        <span>You are Player {config.playerID}: {config.playerDeckLabel} vs {config.opponentDeckLabel}</span>
      </div>
      <PokemonClient credentials={config.credentials} playerID={config.playerID} matchID={config.matchID} />
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
    return <MatchClient config={matchConfig} onExit={() => { setMatchConfig(null); setPage('home'); }} />;
  }

  return (
    <Shell page={page} profile={profile} onNavigate={setPage} onLogout={signOut}>
      {page === 'profile' && <ProfilePage profile={profile} onProfileChange={updateProfile} />}
      {page === 'matchmaking' && (
        <MatchmakingPage
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
