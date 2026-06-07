import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LobbyAPI } from 'boardgame.io';
import { LobbyClient } from 'boardgame.io/client';
import type { BoardProps } from 'boardgame.io/react';
import { Client } from 'boardgame.io/react';
import { Local, SocketIO } from 'boardgame.io/multiplayer';
import { RandomBot } from 'boardgame.io/ai';
import {
  buildBoosterInvoice,
  claimMatchPrize,
  fetchLeaderboard,
  loginProfile,
  persistMatchRecord,
  persistPackPurchase,
  persistProfile,
  redeemBoosterInvoice,
  scanWalletForImports,
  type ClaimedPrize,
  type ImportCandidate,
} from './api/profiles';
import { MULTIPLAYER_SERVER } from './api/server';
import { CardImage } from './components/CardImage';
import { BackgroundMusicPlayer } from './components/BackgroundMusicPlayer';
import {
  CARD_LIBRARY,
  ENERGY_TYPE_META,
  STARTER_DECKS,
  STARTER_ENERGY_TYPES,
  type StarterEnergyType,
} from './game/cards';
import { PokemonTCG } from './game/PokemonTCG';
import type { Card, MatchType, PlayerID, PokemonTCGSetupData, PokemonTCGState, WagerCurrency } from './game/types';
import { POKETCG_TOKEN_MINT, formatWager } from './game/types';
import { PokemonBoard } from './PokemonBoard';
import {
  addCardsToCollection,
  collectionFromCards,
  collectionSize,
  type CustomDeck,
  type ImportedNftRecord,
  maxCollections,
  type MatchLeaderboardEntry,
  type MatchRecord,
  nftOwnedCount,
  nftOwnedUniqueCount,
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
import {
  formatCountdown,
  formatWaitTime,
  getCurrentSeasonalEvent,
  getTrainerStats,
  MATCH_TYPE_OPTIONS,
  QUEUE_AUTO_CREATE_AFTER_MS,
  QUEUE_POLL_INTERVAL_MS,
  rankFromLeaderboard,
  summariseRecentForm,
} from './matchmaking/helpers';
import {
  computeRegionProgress,
  computeTypeBreakdown,
  countOwnedRarity,
  dominantTypeForProfile,
  findShowcaseCard,
  MOCK_ACHIEVEMENTS,
  mostPlayedDeck,
  overallCollectionPct,
  summariseDeck,
} from './profile/data';
import {
  AchievementBadgeGrid,
  CollectionProgress,
  LeaderboardPanel as ProfileLeaderboardPanel,
  MatchHistory as ProfileMatchHistory,
  ProfileTabs,
  StatCard,
  StatSection,
  TrainerHeroBanner,
  type ProfileTabId,
} from './profile/components';
import {
  applyWin,
  loadCampaignProgress,
  recommendedNext,
  saveCampaignProgress,
  type CampaignOpponent,
  type CampaignProgress,
} from './campaign/data';
import {
  BadgeCase,
  CampaignHero,
  CampaignRewardsPanel,
  ChampionPanel,
  EliteFourPanel,
  GymRow,
  VictoryRewardModal,
} from './campaign/components';
import {
  applyFilterAndSort,
  computeSetCompletion,
  getRarityEffectClass,
  groupSetsByEra,
  type BoosterFilter,
  type BoosterSort,
  type SetMetaLike,
} from './boosters/helpers';
import {
  BoosterEmptyState,
  BoosterEraSection,
  BoosterFiltersBar,
  BoosterHero,
  BoosterTabs,
  CollectionTab,
  RecentOpeningsTab,
  type BoosterTabId,
} from './boosters/components';
import {
  getTelegramUser,
  initTelegramWebApp,
  isTelegramMiniApp,
  showTelegramBackButton,
  telegramDisplayName,
  telegramPseudoAddress,
} from './telegram';
import setsManifest from './data/pokemon-tcg-data/sets/en.json' with { type: 'json' };

type Page = 'signin' | 'home' | 'profile' | 'matchmaking' | 'boosters' | 'imports' | 'bot' | 'match';

const NEWS_URL = 'https://x.com/pokemasterstcg';
const TELEGRAM_URL = 'https://t.me/PokemastersTCGBot/Play';

interface MatchConfig {
  matchID: string;
  matchName: string;
  matchType: MatchType;
  wagerAmount: number;
  wagerCurrency: WagerCurrency;
  playerDeck?: DeckPayload;
  playerWallet?: string;
  playerID: PlayerID;
  credentials: string;
  playerDeckLabel: string;
  opponentDeckLabel: string;
  server: string;
}

interface MatchSetupData extends PokemonTCGSetupData {
  deckLabels?: Partial<Record<PlayerID, string>>;
  /** When true, the match is hidden from the public Available Matches
   *  list (joinable only via direct link / Quick Play matchID). */
  isPrivate?: boolean;
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
const PACK_PRICE_LABEL = (import.meta.env.VITE_PACK_PRICE_LABEL?.trim() || '$6 USDC');
const SOLANA_RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const GAME_NAME = PokemonTCG.name ?? 'pokemon-tcg';
const PLAYER_IDS: PlayerID[] = ['0', '1'];
const MATCH_TYPES: MatchType[] = ['Casual', 'Ranked', 'Wager', 'Theme Deck', 'Unlimited', 'Tournament Practice'];
const WAGER_CURRENCIES: { value: WagerCurrency; label: string }[] = [
  { value: 'SOL', label: 'SOL' },
  { value: 'POKETCG', label: '$POKETCG' },
];
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

type BoosterSlot = 'Common' | 'Uncommon' | 'Rare';
interface BoosterPull {
  card: Card;
  slot: BoosterSlot;
}

// ----- Per-set booster packs -----
//
// Every Pokemon TCG set has its own pack. Pulls are restricted to cards from
// that set (except Basic Energies, which are always pulled from the canonical
// Scarlet & Violet Energies set so any pack opens with a usable energy).
//
// A set is considered "boosterable" when it has at least one Common, one
// Uncommon, and one rarer non-energy card so we can actually fill all six
// pack slots. The full sets/en.json file ships with logo + symbol URLs that
// we use as pack art on the boosters page.

interface RawSet {
  id: string;
  name: string;
  series?: string;
  releaseDate?: string;
  ptcgoCode?: string;
  total?: number;
  images?: { logo?: string; symbol?: string };
}

interface SetMeta {
  id: string;
  name: string;
  series: string;
  releaseDate: string;
  ptcgoCode?: string;
  logo?: string;
  symbol?: string;
}

interface BoosterableSet extends SetMeta {
  commons: Card[];
  uncommons: Card[];
  rares: Card[];
  totalCards: number;
}

function setIdOf(card: Card): string {
  const dash = card.id.indexOf('-');
  return dash > 0 ? card.id.slice(0, dash) : card.id;
}

const SET_METADATA: Map<string, SetMeta> = new Map(
  (setsManifest as RawSet[]).map((set) => [
    set.id,
    {
      id: set.id,
      name: set.name,
      series: set.series ?? 'Other',
      releaseDate: set.releaseDate ?? '0000/00/00',
      ptcgoCode: set.ptcgoCode,
      logo: set.images?.logo,
      symbol: set.images?.symbol,
    },
  ]),
);

function isRareForBoosters(card: Card): boolean {
  if (card.kind === 'energy') return false;
  const rarity = card.rarity;
  if (!rarity) return false;
  if (rarity === 'Common' || rarity === 'Uncommon' || rarity === 'Promo') return false;
  return true;
}

function buildBoosterableSets(): BoosterableSet[] {
  const byId = new Map<string, Card[]>();
  for (const card of CANONICAL_CARDS) {
    const id = setIdOf(card);
    const list = byId.get(id);
    if (list) list.push(card);
    else byId.set(id, [card]);
  }

  const result: BoosterableSet[] = [];
  for (const [setId, cards] of byId) {
    const meta = SET_METADATA.get(setId);
    if (!meta) continue;
    const commons = cards.filter((card) => card.rarity === 'Common');
    const uncommons = cards.filter((card) => card.rarity === 'Uncommon');
    const rares = cards.filter(isRareForBoosters);
    if (commons.length === 0 || uncommons.length === 0 || rares.length === 0) continue;
    result.push({
      ...meta,
      commons,
      uncommons,
      rares,
      totalCards: cards.length,
    });
  }

  return result.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
}

const BOOSTERABLE_SETS = buildBoosterableSets();
const BOOSTERABLE_SET_BY_ID = new Map(BOOSTERABLE_SETS.map((set) => [set.id, set]));

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

function randomRareFromSet(pool: Card[], used: Set<string>): Card {
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
      const bucket = pool.filter((card) => rareBucket(card) === entry.bucket);
      if (bucket.length > 0) {
        return randomFromPool(bucket, used);
      }
    }
  }
  return randomFromPool(pool, used);
}

function makeBoosterPackForSet(set: BoosterableSet): BoosterPull[] {
  const used = new Set<string>();
  return [
    ...Array.from({ length: 4 }, () => ({ card: randomFromPool(set.commons, used), slot: 'Common' as const })),
    ...Array.from({ length: 3 }, () => ({ card: randomFromPool(set.uncommons, used), slot: 'Uncommon' as const })),
    { card: randomRareFromSet(set.rares, used), slot: 'Rare' as const },
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

function wagerForMatch(match: LobbyAPI.Match): number {
  const value = setupDataForMatch(match)?.wagerAmount;
  return typeof value === 'number' && value > 0 ? value : 0;
}

function wagerCurrencyForMatch(match: LobbyAPI.Match): WagerCurrency {
  return setupDataForMatch(match)?.wagerCurrency === 'POKETCG' ? 'POKETCG' : 'SOL';
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
          {(['home', 'profile', 'matchmaking', 'bot', 'boosters', 'imports'] as Page[]).map((target) => (
            <button
              className={page === target ? 'nav-active' : ''}
              key={target}
              onClick={() => onNavigate(target)}
            >
              {target === 'matchmaking'
                ? 'Matchmaking'
                : target === 'bot'
                  ? 'Vs Bot'
                  : target === 'imports'
                    ? 'Import'
                    : target[0].toUpperCase() + target.slice(1)}
            </button>
          ))}
          <a className="nav-news" href={NEWS_URL} target="_blank" rel="noreferrer">News ↗</a>
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

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

const RESERVED_NAMES = new Set(['pokemontrainer', 'pokemon trainer', 'trainer', 'player', 'anonymous']);

function isReservedName(value: string): boolean {
  const normalized = normalizeName(value);
  if (!normalized) return true;
  return RESERVED_NAMES.has(normalized) || RESERVED_NAMES.has(normalized.replace(/\s+/g, ''));
}

function SignInPage({ onSignIn }: { onSignIn: (profile: ProfileState) => void }) {
  const [name, setName] = useState(() => {
    const cached = loadProfile().name;
    if (cached && !isReservedName(cached)) return cached;
    const tgUser = getTelegramUser();
    return tgUser ? telegramDisplayName(tgUser) : '';
  });
  const [wallet, setWallet] = useState<ConnectedWallet | null>(() => loadProfile().wallet);
  const [error, setError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const solanaWallets = detectSolanaWallets();
  const telegramUser = getTelegramUser();
  const inTelegram = Boolean(telegramUser);
  // Inside Telegram, the Telegram user identity replaces the wallet
  // requirement — we synthesise a stable pseudo-wallet keyed by their
  // Telegram user ID so the existing profile + leaderboard pipeline
  // works without changes. Wallet-gated features (boosters, wager
  // settlement, NFT prizes) are disabled downstream when chain === 'telegram'.
  const effectiveWallet: ConnectedWallet | null = wallet ?? (telegramUser
    ? { chain: 'telegram', address: telegramPseudoAddress(telegramUser) }
    : null);

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
    if (!effectiveWallet) {
      setError('Connect a wallet to enter the arena.');
      return;
    }
    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setError('Pick a trainer name (at least 2 characters).');
      return;
    }
    if (isReservedName(trimmedName)) {
      setError(`"${trimmedName}" is reserved. Choose a unique trainer name.`);
      return;
    }
    setSigningIn(true);
    const profile = { ...DEFAULT_PROFILE, ...loadProfile(), name: trimmedName, wallet: effectiveWallet };
    try {
      onSignIn(await loginAndStore(profile));
    } catch (err) {
      setError(`Could not load stored profile: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSigningIn(false);
    }
  }

  const nameInvalid = name.length > 0 && isReservedName(name);
  const canEnter = Boolean(effectiveWallet) && name.trim().length >= 2 && !isReservedName(name);

  return (
    <main className="signin-page">
      <section className="signin-card">
        <img className="signin-logo" src="/site-logo.png" alt="Pokemon Masters" />
        {inTelegram ? (
          <>
            <p className="eyebrow">Telegram sign-in</p>
            <h1>Pokemon TCG Arena</h1>
            <p>Signed in as <strong>{telegramDisplayName(telegramUser!)}</strong> via Telegram. You can play Casual matches and CPU games here — connect a Solana wallet from a browser to buy boosters, claim NFT prizes, or play Wager matches.</p>
          </>
        ) : (
          <>
            <p className="eyebrow">Wallet sign-in required</p>
            <h1>Pokemon TCG Arena</h1>
            <p>Connect a Solana or EVM wallet to enter. Your profile, collection, pack history, and match records are tied to your wallet so they follow you across browsers and devices.</p>
          </>
        )}
        <label>
          Trainer name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Pick a unique trainer name"
            maxLength={32}
          />
        </label>
        {nameInvalid && <p className="action-hint" style={{ color: '#ff8a8a' }}>"{name.trim()}" is reserved — pick a different name.</p>}
        {!inTelegram && (
          <>
            <div className="wallet-actions">
              <button onClick={() => connect('evm')}>Connect EVM Wallet</button>
              <button onClick={() => connect('solana')}>Connect Solana Wallet</button>
            </div>
            <div className="wallet-list">
              {solanaWallets.map((walletInfo) => (
                <span key={walletInfo.kind}>{walletInfo.label}: {walletInfo.installed ? 'installed' : 'not found'}</span>
              ))}
            </div>
          </>
        )}
        {effectiveWallet ? (
          <p className="success">
            {effectiveWallet.chain === 'telegram'
              ? `Telegram identity ready: ${telegramUser ? telegramDisplayName(telegramUser) : shortAddr(effectiveWallet.address)}`
              : `Connected ${effectiveWallet.chain}: ${shortAddr(effectiveWallet.address)}`}
          </p>
        ) : (
          <p className="action-hint">No wallet connected yet — pick one above to unlock the arena.</p>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary-cta" disabled={signingIn || !canEnter} onClick={finish}>
          {signingIn ? 'Loading profile...' : effectiveWallet ? 'Enter Arena' : 'Connect a wallet to continue'}
        </button>
      </section>
    </main>
  );
}

function HomePage({ profile, onNavigate }: { profile: ProfileState; onNavigate: (page: Page) => void }) {
  const stats = useMemo(() => {
    const records = profile.matchRecords ?? [];
    const wins = records.filter((record) => record.result === 'win').length;
    const losses = records.filter((record) => record.result === 'loss').length;
    return {
      collection: nftOwnedCount(profile),
      packsOpened: profile.packsOpened,
      record: `${wins}-${losses}`,
    };
  }, [profile]);

  return (
    <main className="hub-page">
      <section className="home-sidebar" aria-label="Home navigation">
        <div>
          <p className="eyebrow">Welcome back, {profile.name}</p>
          <h1>Step into the Arena.</h1>
        </div>
        <div className="home-stats">
          <div className="home-stat">
            <strong>{stats.collection}</strong>
            <span>Collection</span>
          </div>
          <div className="home-stat">
            <strong>{stats.record}</strong>
            <span>Record</span>
          </div>
          <div className="home-stat">
            <strong>{stats.packsOpened}</strong>
            <span>Packs</span>
          </div>
        </div>
        <div className="home-button-stack">
          <button className="home-menu-button primary-cta" onClick={() => onNavigate('matchmaking')}>
            <strong>Matchmaking</strong>
            <span>Create an online match or accept an open challenge.</span>
          </button>
          <button className="home-menu-button" onClick={() => onNavigate('bot')}>
            <strong>⚔ Gym Challenge</strong>
            <span>Single-player campaign — battle 8 Gym Leaders, the Elite Four, and the Champion.</span>
          </button>
          <button className="home-menu-button" onClick={() => onNavigate('profile')}>
            <strong>Profile + Deckbuilder</strong>
            <span>Manage your profile and custom deck library.</span>
          </button>
          <button className="home-menu-button" onClick={() => onNavigate('boosters')}>
            <strong>Boosters</strong>
            <span>Open packs for {PACK_PRICE_LABEL} and grow your collection.</span>
          </button>
          <button className="home-menu-button" onClick={() => onNavigate('imports')}>
            <strong>Import phygitals / Collector Crypt</strong>
            <span>Scan your Solana wallet and pull NFT-backed Pokemon cards into the game.</span>
          </button>
          <a
            className="home-menu-button home-news-button"
            href={NEWS_URL}
            target="_blank"
            rel="noreferrer"
          >
            <strong>News ↗</strong>
            <span>Patch notes and announcements on x.com/pokemasterstcg.</span>
          </a>
          <a
            className="home-menu-button home-telegram-button"
            href={TELEGRAM_URL}
            target="_blank"
            rel="noreferrer"
          >
            <strong>Telegram ↗</strong>
            <span>Play inside Telegram via @PokemastersTCGBot — one-tap sign-in, no wallet required for Casual + CPU matches.</span>
          </a>
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

  async function deleteDeck(deckEntry: CustomDeck) {
    const confirmed = typeof window !== 'undefined'
      ? window.confirm(`Delete "${deckEntry.name}"? This cannot be undone.`)
      : true;
    if (!confirmed) return;
    setStatus('');
    setError('');
    const nextLibrary = deckLibrary.filter((candidate) => candidate.id !== deckEntry.id);
    // If the deleted deck was the active deck, clear active state so the
    // user lands on a blank deck and the profile's activeDeckName is
    // freed up for the next save.
    const wasActive = profile.activeDeckName === deckEntry.name;
    const next: ProfileState = {
      ...profile,
      deckLibrary: nextLibrary,
      activeDeckName: wasActive ? 'No Custom Deck' : profile.activeDeckName,
      customDeck: wasActive ? [] : profile.customDeck,
    };
    try {
      const saved = await persistAndStore(next);
      onProfileChange(saved);
      setDeckLibrary(saved.deckLibrary);
      if (editingDeckId === deckEntry.id) {
        setEditingDeckId(null);
        setDeckName('New Custom Deck');
        setDeck([]);
      }
      setStatus(`Deleted ${deckEntry.name}.`);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
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

  const stats = useMemo(() => getTrainerStats(profile), [profile]);
  const showcase = useMemo(() => findShowcaseCard(profile), [profile]);
  const typeBreakdown = useMemo(() => computeTypeBreakdown(profile), [profile]);
  const regionProgress = useMemo(() => computeRegionProgress(profile), [profile]);
  const overallPct = useMemo(() => overallCollectionPct(profile), [profile]);
  const collectionTotal = nftOwnedCount(profile);
  const uniqueCardsCount = nftOwnedUniqueCount(profile);
  const secretRareCount = useMemo(() => countOwnedRarity(profile, /Secret|Rainbow|Hyper/i), [profile]);
  const fullArtCount = useMemo(() => countOwnedRarity(profile, /Full Art|Illustration|Trainer Gallery/i), [profile]);
  const nftMints = profile.packPurchases.reduce((sum, pack) => sum + (pack.mints?.length ?? 0), 0);
  const favoriteDeck = useMemo(() => mostPlayedDeck(profile), [profile]);
  const dominantType = useMemo(() => dominantTypeForProfile(profile), [profile]);
  const avgDeckSize = profile.deckLibrary.length === 0
    ? 0
    : Math.round(profile.deckLibrary.reduce((sum, d) => sum + d.cardIds.length, 0) / profile.deckLibrary.length);

  const [activeTab, setActiveTab] = useState<ProfileTabId>('profile');
  const [leaderboard, setLeaderboard] = useState<MatchLeaderboardEntry[]>([]);
  useEffect(() => {
    if (activeTab !== 'leaderboard') return;
    let cancelled = false;
    fetchLeaderboard().then((rows) => { if (!cancelled) setLeaderboard(rows); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeTab]);

  return (
    <main className="content-page profile-page">
      <TrainerHeroBanner
        profile={profile}
        stats={stats}
        collectionScore={Math.round(overallPct * 10) / 10}
        cardsOwned={collectionTotal}
        showcaseCardId={showcase?.cardId}
        showcaseReason={showcase?.reason}
      />

      <ProfileTabs active={activeTab} onChange={setActiveTab} />

      {activeTab === 'profile' && (
        <div className="profile-tab-pane">
          <section className="panel profile-panel">
            <div>
              <p className="eyebrow">Identity</p>
              <h2>Display name</h2>
              <p>{profile.wallet ? `${profile.wallet.chain.toUpperCase()} ${shortAddr(profile.wallet.address)}` : 'No wallet connected'}</p>
            </div>
            <label>
              Display name
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            {status && <p className="success">{status}</p>}
            {error && <p className="error">{error}</p>}
          </section>

          <StatSection title="Battle stats">
            <StatCard label="Wins" value={stats.rankedWins} />
            <StatCard label="Losses" value={stats.rankedLosses} />
            <StatCard label="Win rate" value={`${stats.winRate}%`} hint={`${stats.rankedTotal} ranked`} />
            <StatCard label="Ranked record" value={`${stats.rankedWins}-${stats.rankedLosses}${stats.rankedDraws ? `-${stats.rankedDraws}` : ''}`} />
            <StatCard label="Casual matches" value={stats.casualMatches} />
            <StatCard label="Total matches" value={stats.totalMatches} />
          </StatSection>

          <StatSection title="Collection stats">
            <StatCard label="NFT cards owned" value={collectionTotal} hint={`${uniqueCardsCount} unique`} />
            <StatCard label="Unique cards" value={uniqueCardsCount} />
            <StatCard label="Secret / Hyper rares" value={secretRareCount} />
            <StatCard label="Full Art / Illustration" value={fullArtCount} />
            <StatCard label="Packs opened" value={profile.packsOpened} />
            <StatCard label="NFTs minted" value={nftMints} />
            <StatCard label="NFTs imported" value={profile.importedNfts?.length ?? 0} />
          </StatSection>

          <StatSection title="Deck stats">
            <StatCard label="Custom decks saved" value={profile.deckLibrary.length} />
            <StatCard label="Favourite deck" value={favoriteDeck ?? '—'} hint={favoriteDeck ? 'Most played in match history' : 'Play a match to set'} />
            <StatCard label="Most played type" value={dominantType ?? '—'} hint={dominantType ? 'By NFT mints' : 'Open packs to set'} />
            <StatCard label="Avg deck size" value={`${avgDeckSize}/60`} />
          </StatSection>
        </div>
      )}

      {activeTab === 'collection' && (
        <div className="profile-tab-pane">
          <section className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Collection progress</p>
                <h2>{collectionTotal} NFTs · {uniqueCardsCount} unique</h2>
              </div>
            </div>
            <CollectionProgress
              overallPct={overallPct}
              regions={regionProgress}
              types={typeBreakdown}
            />
          </section>
        </div>
      )}

      {activeTab === 'decks' && (
        <div className="profile-tab-pane">
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
                    const breakdown = summariseDeck(deckEntry.cardIds);
                    const matchesWithDeck = profile.matchRecords.filter((r) => r.playerDeckLabel === deckEntry.name);
                    const wins = matchesWithDeck.filter((r) => r.result === 'win').length;
                    const losses = matchesWithDeck.filter((r) => r.result === 'loss').length;
                    const lastPlayed = matchesWithDeck.length > 0 ? matchesWithDeck[matchesWithDeck.length - 1].startedAt : undefined;
                    return (
                      <article className={`deck-library-card ${editingDeckId === deckEntry.id ? 'deck-library-card-active' : ''}`} key={deckEntry.id}>
                        <div>
                          <strong>{deckEntry.name}</strong>
                          <span className="deck-library-card-breakdown">
                            {breakdown.size}/{DECK_SIZE} · 🐉 {breakdown.pokemonCount} · 🎓 {breakdown.trainerCount} · ⚡ {breakdown.energyCount}
                            {breakdown.dominantType && <> · {breakdown.dominantType}</>}
                          </span>
                          {matchesWithDeck.length > 0 && (
                            <span className="deck-library-card-record">{wins}W / {losses}L · {matchesWithDeck.length > 0 ? Math.round((wins / matchesWithDeck.length) * 100) : 0}% win</span>
                          )}
                          {lastPlayed && (
                            <span className="deck-library-card-last">Last played {new Date(lastPlayed).toLocaleDateString()}</span>
                          )}
                          <span>{deckIssues.length === 0 ? '✓ Ready for matches' : `${deckIssues.length} issue${deckIssues.length === 1 ? '' : 's'}`}</span>
                        </div>
                        <div className="deck-library-card-actions">
                          <button onClick={() => loadDeck(deckEntry)}>Edit</button>
                          <button className="danger" onClick={() => deleteDeck(deckEntry)}>Delete</button>
                        </div>
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
        </div>
      )}

      {activeTab === 'match-history' && (
        <div className="profile-tab-pane">
          <section className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Battle log</p>
                <h2>{profile.matchRecords.length} match{profile.matchRecords.length === 1 ? '' : 'es'} on record</h2>
              </div>
            </div>
            <ProfileMatchHistory records={profile.matchRecords} />
          </section>

          {profile.packPurchases.length > 0 && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Booster history</p>
                  <h2>{profile.packPurchases.length} pack{profile.packPurchases.length === 1 ? '' : 's'} opened</h2>
                </div>
              </div>
              <div className="pack-history-list">
                {[...profile.packPurchases].reverse().slice(0, 10).map((purchase) => (
                  <article className="pack-history-card" key={purchase.signature}>
                    <div>
                      <strong>{purchase.cardIds.length} cards</strong>
                      <span>{new Date(purchase.openedAt).toLocaleString()}</span>
                      {purchase.mints && purchase.mints.length > 0 && (
                        <span>{purchase.mints.length} NFT{purchase.mints.length === 1 ? '' : 's'} minted</span>
                      )}
                    </div>
                    {purchase.signature && (
                      <a href={`https://solscan.io/tx/${purchase.signature}`} target="_blank" rel="noreferrer">
                        View tx ↗
                      </a>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {activeTab === 'achievements' && (
        <div className="profile-tab-pane">
          <section className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Achievements <span className="mock-tag">(catalogue isolated; unlock checks read real data)</span></p>
                <h2>{MOCK_ACHIEVEMENTS.filter((a) => a.unlocked(profile)).length} / {MOCK_ACHIEVEMENTS.length} unlocked</h2>
              </div>
            </div>
            <AchievementBadgeGrid profile={profile} achievements={MOCK_ACHIEVEMENTS} />
          </section>
        </div>
      )}

      {activeTab === 'leaderboard' && (
        <div className="profile-tab-pane">
          <section className="panel leaderboard-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Hall of fame</p>
                <h2>🏆 Leaderboard</h2>
              </div>
            </div>
            <ProfileLeaderboardPanel entries={leaderboard} selfUserId={profile.userId} />
          </section>
        </div>
      )}
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
  const [wagerAmount, setWagerAmount] = useState<number>(0.1);
  const [wagerCurrency, setWagerCurrency] = useState<WagerCurrency>('SOL');
  const [isPrivate, setIsPrivate] = useState(false);
  const [matches, setMatches] = useState<LobbyAPI.Match[]>([]);
  const [leaderboard, setLeaderboard] = useState<MatchLeaderboardEntry[]>([]);
  const [busy, setBusy] = useState<'create' | 'refresh' | string | null>(null);
  const [error, setError] = useState('');
  // Quick Play queue state. While `queue` is non-null we poll for an
  // open Casual match every QUEUE_POLL_INTERVAL_MS and auto-accept the
  // first one; if we time out after QUEUE_AUTO_CREATE_AFTER_MS we fall
  // back to creating a Casual match the next user can pick up.
  const [queue, setQueue] = useState<{ startedAt: number; deckId: string } | null>(null);
  const [queueElapsed, setQueueElapsed] = useState(0);
  const lobby = useMemo(() => new LobbyClient({ server: MULTIPLAYER_SERVER }), []);
  const selectedPlayerDeck = deckOptionById(deckOptions, playerDeckId);
  const selectedAcceptDeck = deckOptionById(deckOptions, acceptDeckId);
  const playerWallet = profile.wallet?.chain === 'solana' ? profile.wallet.address : undefined;
  const trainerStats = useMemo(() => getTrainerStats(profile), [profile]);
  const seasonalEvent = useMemo(() => getCurrentSeasonalEvent(), []);
  const [seasonalTick, setSeasonalTick] = useState(0);
  // Re-render the countdown every minute so the banner stays fresh.
  useEffect(() => {
    const interval = window.setInterval(() => setSeasonalTick((t) => t + 1), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  void seasonalTick;

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
      // Hide private matches from the public list — they're still
      // joinable by direct matchID, but won't clutter the lobby.
      const openMatches = listedMatches.filter((match) => {
        const setup = setupDataForMatch(match) as MatchSetupData | undefined;
        if (setup?.isPrivate) return false;
        return Boolean(openSeat(match));
      });
      setMatches(openMatches);
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

  // Quick Play loop. While `queue` is active: every QUEUE_POLL_INTERVAL_MS,
  // list matches and auto-accept the first open Casual one. If we haven't
  // matched within QUEUE_AUTO_CREATE_AFTER_MS, create a Casual match so
  // someone else can pick US up. UI gets a live elapsed counter via
  // `queueElapsed`.
  useEffect(() => {
    if (!queue) return;
    let cancelled = false;

    const tick = window.setInterval(() => {
      if (!cancelled) setQueueElapsed(Date.now() - queue.startedAt);
    }, 250);

    async function tryFindMatch() {
      try {
        const { matches: listedMatches } = await lobby.listMatches(GAME_NAME, { isGameover: false });
        if (cancelled) return;
        const ourMatchIDs = new Set(profile.matchRecords.map((r) => r.matchID));
        const candidate = listedMatches.find((match) => {
          if (!openSeat(match)) return false;
          const setup = setupDataForMatch(match) as MatchSetupData | undefined;
          if (setup?.matchType === 'Wager') return false; // never auto-accept a wager match
          if (setup?.isPrivate) return false;
          if (ourMatchIDs.has(match.matchID)) return false; // skip our own
          return true;
        });
        if (candidate) {
          setQueue(null);
          await acceptMatch(candidate);
          return;
        }
        if (Date.now() - queue!.startedAt > QUEUE_AUTO_CREATE_AFTER_MS) {
          // Drop out of the queue and create a public match so others
          // can find us. Don't await — the create flow navigates us into
          // the match screen.
          setQueue(null);
          await createMatch();
        }
      } catch (err) {
        console.warn('[quickplay] poll failed', err);
      }
    }

    const pollHandle = window.setInterval(() => { void tryFindMatch(); }, QUEUE_POLL_INTERVAL_MS);
    // Immediate first pass so the queue feels responsive.
    void tryFindMatch();

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      window.clearInterval(pollHandle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue?.startedAt]);

  function startQuickPlay() {
    setError('');
    if (!selectedPlayerDeck || selectedPlayerDeck.issues.length > 0) {
      setError('Select a ready-to-play deck before queuing up.');
      return;
    }
    setQueue({ startedAt: Date.now(), deckId: playerDeckId });
    setQueueElapsed(0);
  }

  function cancelQuickPlay() {
    setQueue(null);
    setQueueElapsed(0);
  }

  async function recordStartedMatch(config: MatchConfig): Promise<void> {
    const record: MatchRecord = {
      matchID: config.matchID,
      matchType: config.matchType,
      playerID: config.playerID,
      playerDeckLabel: config.playerDeckLabel,
      opponentDeckLabel: config.opponentDeckLabel,
      wagerAmount: config.wagerAmount > 0 ? config.wagerAmount : undefined,
      wagerCurrency: config.wagerAmount > 0 ? config.wagerCurrency : undefined,
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

    const isWager = matchType === 'Wager';
    if (isWager) {
      if (!playerWallet) {
        setError('Connect a Solana wallet on sign-in to create a Wager match.');
        return;
      }
      if (!(wagerAmount > 0)) {
        setError(`Wager matches need a positive ${wagerCurrency === 'POKETCG' ? '$POKETCG' : 'SOL'} amount.`);
        return;
      }
    }

    const cleanMatchName = matchName.trim() || `${profile.name}'s ${matchType} Match`;
    const deckLabels: Partial<Record<PlayerID, string>> = {
      '0': selectedPlayerDeck.label,
    };
    const walletAddresses: Partial<Record<PlayerID, string>> | undefined = isWager && playerWallet
      ? { '0': playerWallet }
      : undefined;
    const setupData: MatchSetupData = {
      matchName: cleanMatchName,
      matchType,
      wagerAmount: isWager ? wagerAmount : undefined,
      wagerCurrency: isWager ? wagerCurrency : undefined,
      seedDecks: {
        '0': selectedPlayerDeck.cardIds,
      },
      deckLabels,
      walletAddresses,
      isPrivate,
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
      const config: MatchConfig = {
        matchID,
        matchName: cleanMatchName,
        matchType,
        wagerAmount: isWager ? wagerAmount : 0,
        wagerCurrency: isWager ? wagerCurrency : 'SOL',
        playerID,
        playerWallet,
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
    const matchKind = matchTypeForMatch(match);
    const matchWager = wagerForMatch(match);
    const matchCurrency = wagerCurrencyForMatch(match);
    if (matchKind === 'Wager' && !playerWallet) {
      setError('Connect a Solana wallet on sign-in to accept a Wager match.');
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
      const config: MatchConfig = {
        matchID: match.matchID,
        matchName: matchNameForMatch(match),
        matchType: matchKind,
        wagerAmount: matchWager,
        wagerCurrency: matchCurrency,
        playerDeck: {
          cardIds: selectedAcceptDeck.cardIds,
          label: selectedAcceptDeck.label,
        },
        playerID,
        playerWallet,
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

  // Mock-data: derive an "online trainers" list from the leaderboard so
  // we have *something* to show until a real presence system lands. Each
  // entry gets a fake online indicator. Clearly isolated — search for
  // ONLINE_TRAINERS_MOCK to find / replace.
  const ONLINE_TRAINERS_MOCK = leaderboard.slice(0, 8).map((entry) => ({
    userId: entry.userId,
    name: entry.name,
    online: true,
  }));
  const onlineCount = ONLINE_TRAINERS_MOCK.length + matches.length + 1; // +1 for current user

  return (
    <main className="content-page matchmaking-page">
      {/* ===== Seasonal event banner (top, full width) ===== */}
      <section className="panel seasonal-banner">
        <div className="seasonal-banner-headline">
          <span className="seasonal-banner-emoji" aria-hidden="true">{seasonalEvent.emoji}</span>
          <div>
            <p className="eyebrow">Seasonal event {seasonalEvent.isMock && <span className="mock-tag">(preview)</span>}</p>
            <h2>{seasonalEvent.title}</h2>
          </div>
        </div>
        <div className="seasonal-banner-rewards">
          {seasonalEvent.rewards.map((reward) => (
            <span key={reward} className="seasonal-reward-chip">🎁 {reward}</span>
          ))}
          <span className="seasonal-countdown">Ends in {formatCountdown(seasonalEvent.endsAt)}</span>
        </div>
      </section>

      <div className="matchmaking-grid">
        {/* ===== LEFT COLUMN: Quick Play + Create Match ===== */}
        <div className="matchmaking-col matchmaking-col-left">
          <section className={`panel quick-play-panel${queue ? ' quick-play-panel-active' : ''}`}>
            <p className="eyebrow">Fast track</p>
            <h2>⚡ Quick Play</h2>
            {queue ? (
              <>
                <p className="quick-play-status">Searching for opponent…</p>
                <p className="quick-play-meta">Elapsed: <strong>{formatWaitTime(queueElapsed)}</strong> · Type: <strong>Casual</strong> · Deck: <strong>{selectedPlayerDeck?.label ?? '—'}</strong></p>
                <p className="quick-play-meta">Estimated wait: {queueElapsed < 15_000 ? '15s' : queueElapsed < 30_000 ? '30s' : 'auto-creating…'}</p>
                <button className="primary-cta danger-cta" onClick={cancelQuickPlay}>Cancel queue</button>
              </>
            ) : (
              <>
                <p className="quick-play-hint">One tap to join the first open Casual match, or auto-create one if nobody's waiting.</p>
                <DeckSelect title="Queue with deck" value={playerDeckId} options={deckOptions} onChange={setPlayerDeckId} />
                <button className="primary-cta quick-play-cta" disabled={!selectedPlayerDeck || selectedPlayerDeck.issues.length > 0} onClick={startQuickPlay}>
                  ⚡ Quick Play
                </button>
              </>
            )}
          </section>

          <section className="panel create-match-panel">
            <p className="eyebrow">Host a match</p>
            <h2>Create match</h2>
            <label className="match-name-field">
              Match name
              <input value={matchName} onChange={(event) => setMatchName(event.target.value)} placeholder={`${profile.name}'s Match`} />
            </label>
            <label className="deck-select">
              Match type
              <select value={matchType} onChange={(event) => setMatchType(event.target.value as MatchType)}>
                {MATCH_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <p className="wager-hint">
              {MATCH_TYPE_OPTIONS.find((o) => o.value === matchType)?.description}
            </p>
            <DeckSelect title="Start as" value={playerDeckId} options={deckOptions} onChange={setPlayerDeckId} />
            <DeckSelect title="Accept as" value={acceptDeckId} options={deckOptions} onChange={setAcceptDeckId} />
            <label className="visibility-toggle">
              <input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />
              <span>Private match (hidden from public lobby; share the match ID directly)</span>
            </label>
            {matchType === 'Wager' && (
              <div className="wager-controls">
                <label className="wager-field">
                  Currency
                  <select value={wagerCurrency} onChange={(event) => setWagerCurrency(event.target.value as WagerCurrency)}>
                    {WAGER_CURRENCIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="wager-field">
                  Wager ({wagerCurrency === 'POKETCG' ? '$POKETCG' : 'SOL'})
                  <input
                    type="number"
                    inputMode="decimal"
                    step={wagerCurrency === 'POKETCG' ? '1' : '0.01'}
                    min={wagerCurrency === 'POKETCG' ? '1' : '0.001'}
                    value={wagerAmount}
                    onChange={(event) => setWagerAmount(Number.parseFloat(event.target.value) || 0)}
                    placeholder={wagerCurrency === 'POKETCG' ? '1000' : '0.10'}
                  />
                </label>
                <p className="wager-hint">
                  {playerWallet
                    ? `Your wallet (${shortAddr(playerWallet)}) goes in the match so the loser knows where to send winnings. The app does NOT escrow funds — settle off-app after the popup appears.${wagerCurrency === 'POKETCG' ? ` $POKETCG mint: ${shortAddr(POKETCG_TOKEN_MINT)}` : ''}`
                    : 'Connect a Solana wallet on sign-in to create or accept a Wager match.'}
                </p>
              </div>
            )}
            <button
              className="primary-cta create-match-cta"
              disabled={busy !== null || !selectedPlayerDeck || selectedPlayerDeck.issues.length > 0 || (matchType === 'Wager' && (!playerWallet || !(wagerAmount > 0)))}
              onClick={createMatch}
            >
              {busy === 'create' ? 'Creating…' : '✨ Create match'}
            </button>
          </section>
        </div>

        {/* ===== CENTER COLUMN: Available Matches ===== */}
        <div className="matchmaking-col matchmaking-col-center">
          <section className="panel matchmaking-center-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Live lobby</p>
                <h1>Available matches <span className="lobby-count">({matches.length})</span></h1>
              </div>
              <button disabled={busy !== null} onClick={refreshMatches}>
                {busy === 'refresh' ? 'Refreshing…' : '↻ Refresh'}
              </button>
            </div>
            {error && <p className="error">{error}</p>}
            {matches.length === 0 ? (
              <div className="lobby-empty-state">
                <span className="lobby-empty-emoji" aria-hidden="true">🎮</span>
                <p>No trainers are currently waiting. Create a match or use ⚡ Quick Play.</p>
              </div>
            ) : (
              <div className="match-list">
                {matches.map((match) => {
                  const seat = openSeat(match);
                  const creator = playerInMatch(match, '0')?.name ?? 'Waiting for creator';
                  const acceptor = playerInMatch(match, '1')?.name ?? 'Open seat';
                  const matchKind = matchTypeForMatch(match);
                  const wager = wagerForMatch(match);
                  const wagerCcy = wagerCurrencyForMatch(match);
                  const seatsFilled = (playerInMatch(match, '0') ? 1 : 0) + (playerInMatch(match, '1') ? 1 : 0);
                  const canAcceptSelectedDeck = Boolean(
                    seat
                    && selectedAcceptDeck
                    && selectedAcceptDeck.issues.length === 0
                    && (matchKind !== 'Wager' || playerWallet),
                  );
                  return (
                    <article className={`match-card match-card-type-${matchKind.replace(/\s+/g, '-')}`} key={match.matchID}>
                      <div>
                        <div className="match-card-meta">
                          <span className={`match-type-badge match-type-badge-${matchKind.replace(/\s+/g, '-')}`}>{matchKind}</span>
                          <span className="match-id-chip">#{match.matchID.slice(0, 8)}</span>
                          {wager > 0 && <span className="wager-chip">{formatWager(wager, wagerCcy)}</span>}
                          <span className="match-seats-chip">{seatsFilled}/2 players</span>
                        </div>
                        <strong>{matchNameForMatch(match)}</strong>
                        <span className="match-card-host">🎓 Host: <strong>{creator}</strong></span>
                        <span>vs {acceptor}</span>
                        <span className="match-card-starter">Host plays {deckLabelForMatch(match, '0')}</span>
                      </div>
                      <button className="primary-cta" disabled={busy !== null || !canAcceptSelectedDeck} onClick={() => acceptMatch(match)}>
                        {busy === match.matchID ? 'Joining…' : matchKind === 'Wager' && !playerWallet ? 'Wallet needed' : '⚔ Join Match'}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="panel leaderboard-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Hall of fame</p>
                <h2>🏆 Leaderboard</h2>
              </div>
            </div>
            {leaderboard.length === 0 ? (
              <p className="empty-state">No ranked records yet. Be the first.</p>
            ) : (
              <table className="leaderboard-table leaderboard-table-ranked">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Trainer</th>
                    <th>Wins</th>
                    <th>Losses</th>
                    <th>Win %</th>
                    <th>Badge</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((entry, index) => {
                    const wr = entry.matches > 0 ? Math.round((entry.wins / entry.matches) * 100) : 0;
                    const rank = rankFromLeaderboard(entry.wins);
                    return (
                      <tr key={entry.userId} className={index < 3 ? `leaderboard-row-top-${index + 1}` : ''}>
                        <td className="leaderboard-rank-cell">
                          {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`}
                        </td>
                        <td>{entry.name}</td>
                        <td>{entry.wins}</td>
                        <td>{entry.losses}</td>
                        <td>{wr}%</td>
                        <td>
                          <span className="rank-badge" style={{ color: rank.color }}>{rank.icon} {rank.name}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>

        {/* ===== RIGHT COLUMN: Player Stats + Online Trainers ===== */}
        <div className="matchmaking-col matchmaking-col-right">
          <section className="panel player-stats-panel">
            <p className="eyebrow">Trainer card</p>
            <h2>{profile.name}</h2>
            <div className="player-stats-rank">
              <span className="rank-badge" style={{ color: trainerStats.rank.color, borderColor: trainerStats.rank.color }}>
                {trainerStats.rank.icon} {trainerStats.rank.name}
              </span>
              <span className="player-level">Lv. {trainerStats.level}</span>
            </div>
            <div className="player-stats-grid">
              <div className="player-stat">
                <strong>{trainerStats.rankedWins}</strong>
                <span>Wins</span>
              </div>
              <div className="player-stats-grid-divider" aria-hidden="true" />
              <div className="player-stat">
                <strong>{trainerStats.rankedLosses}</strong>
                <span>Losses</span>
              </div>
              <div className="player-stats-grid-divider" aria-hidden="true" />
              <div className="player-stat">
                <strong>{trainerStats.winRate}%</strong>
                <span>Win rate</span>
              </div>
            </div>
            <div className="player-recent-form">
              <span className="player-recent-form-label">Recent: </span>
              <span className="player-recent-form-pills">{summariseRecentForm(profile.matchRecords) || '—'}</span>
            </div>
          </section>

          <section className="panel online-trainers-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Lobby</p>
                <h2>🟢 Online <span className="online-count">{onlineCount}</span></h2>
              </div>
            </div>
            <p className="mock-tag">Presence preview · live data once the WebSocket presence service lands</p>
            <ul className="online-trainers-list">
              <li className="online-trainer-row online-trainer-row-self">
                <span className="online-dot" aria-hidden="true" />
                <span><strong>{profile.name}</strong> (you)</span>
              </li>
              {ONLINE_TRAINERS_MOCK.map((trainer) => (
                <li key={trainer.userId} className="online-trainer-row">
                  <span className="online-dot" aria-hidden="true" />
                  <span>{trainer.name}</span>
                </li>
              ))}
              {ONLINE_TRAINERS_MOCK.length === 0 && (
                <li className="online-trainer-empty">No other trainers visible yet.</li>
              )}
            </ul>
          </section>
        </div>
      </div>
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
  const [pack, setPack] = useState<BoosterPull[] | null>(null);
  const [openedSetId, setOpenedSetId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [buyingSetId, setBuyingSetId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [filterMode, setFilterMode] = useState<BoosterFilter>('all');
  const [sortMode, setSortMode] = useState<BoosterSort>('newest');
  const [activeTab, setActiveTab] = useState<BoosterTabId>('shop');
  const [mintSummary, setMintSummary] = useState<Array<{ cardId: string; mintAddress: string; signature: string }>>([]);

  const filteredSets = useMemo(() => {
    return applyFilterAndSort(
      BOOSTERABLE_SETS,
      filterMode,
      sortMode,
      filter,
      (set) => computeSetCompletion(profile, set, CARD_LIBRARY as Record<string, Card>),
    );
  }, [filter, filterMode, sortMode, profile]);

  const erasGrouped = useMemo(() => groupSetsByEra(filteredSets), [filteredSets]);
  const featuredSet = BOOSTERABLE_SETS[0]; // newest set is the default feature
  const totalUniqueCardsInLibrary = Object.keys(CARD_LIBRARY).length;
  const openedSet = openedSetId ? BOOSTERABLE_SET_BY_ID.get(openedSetId) : undefined;

  async function buyPackForSet(set: BoosterableSet) {
    setStatus('');
    setError('');
    if (profile.wallet?.chain !== 'solana') {
      setError('Connect a Solana wallet on sign-in before buying booster packs.');
      return;
    }
    const walletAddress = profile.wallet.address;

    setBuyingSetId(set.id);
    try {
      // 1. Server builds an unsigned pump.fun payment transaction.
      setStatus('Requesting invoice from the server...');
      const invoice = await buildBoosterInvoice(walletAddress);

      // 2. User signs + submits the transaction through their wallet.
      let signAndSendBase64Transaction: typeof import('./walletPayment')['signAndSendBase64Transaction'];
      try {
        ({ signAndSendBase64Transaction } = await import('./walletPayment'));
      } catch (importErr) {
        const message = importErr instanceof Error ? importErr.message : String(importErr);
        if (/dynamically imported module|Failed to fetch|Loading chunk/i.test(message)) {
          setError('A new version of the app was deployed. Reloading...');
          window.setTimeout(() => window.location.reload(), 1200);
          return;
        }
        throw importErr;
      }
      setStatus(`Approve the ${PACK_PRICE_LABEL} payment in your wallet...`);
      const paymentSignature = await signAndSendBase64Transaction({
        payerAddress: walletAddress,
        rpcUrl: SOLANA_RPC_URL,
        transactionBase64: invoice.transactionBase64,
      });

      // 3. Server verifies the on-chain payment, rolls pack contents
      //    deterministically from the invoice memo, and mints NFTs.
      setStatus('Payment sent. Confirming on-chain and minting NFTs...');
      const redeemed = await redeemBoosterInvoice({
        walletAddress,
        memo: invoice.memo,
        startTime: invoice.startTime,
        endTime: invoice.endTime,
        setId: set.id,
        paymentSignature,
      });

      const cardIds = redeemed.pack.map((entry) => entry.card.id);
      const purchase: PackPurchase = {
        signature: paymentSignature,
        openedAt: new Date().toISOString(),
        cardIds,
        mints: redeemed.mints.length > 0 ? redeemed.mints : undefined,
      };
      const updated = {
        ...profile,
        ownedCards: addCardsToCollection(profile.ownedCards, cardIds),
        packsOpened: profile.packsOpened + 1,
        packPurchases: [...profile.packPurchases, purchase],
      };
      const saved = await persistPackAndStore(updated, purchase);
      onProfileChange(saved);
      setPack(redeemed.pack as unknown as BoosterPull[]);
      setOpenedSetId(set.id);
      setMintSummary(redeemed.mints);
      setStatus(`${set.name} pack opened. ${cardIds.length} cards added to your collection and minted as NFTs.`);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBuyingSetId(null);
    }
  }

  function handleBuyAgain(setId: string) {
    const set = BOOSTERABLE_SET_BY_ID.get(setId);
    if (set) void buyPackForSet(set);
  }

  return (
    <main className="content-page boosters-page">
      <BoosterHero
        profile={profile}
        featuredSet={featuredSet}
        priceLabel={PACK_PRICE_LABEL}
        onBuy={() => featuredSet && buyPackForSet(featuredSet)}
        onJumpToCollection={() => setActiveTab('collection')}
      />

      <BoosterTabs active={activeTab} onChange={setActiveTab} />

      {status && <p className="success">{status}</p>}
      {error && <p className="error">{error}</p>}

      {/* Reveal panel shows on every tab when a pack was just opened. */}
      {pack && openedSet && (
        <section className="panel booster-reveal">
          <div className="section-heading">
            <div>
              <p className="eyebrow">✨ Latest pull</p>
              <h2>{openedSet.name}</h2>
              <p className="section-subtitle">{openedSet.series} · {new Date(openedSet.releaseDate).getFullYear()}</p>
            </div>
            <button onClick={() => { setPack(null); setOpenedSetId(null); setMintSummary([]); }}>Close</button>
          </div>
          <div className="booster-grid">
            {pack.map(({ card, slot }, index) => {
              const mint = mintSummary.find((m) => m.cardId === card.id);
              return (
                <article className={`booster-card ${getRarityEffectClass(card.rarity)}`} key={`${card.id}-${index}`}>
                  <DeckbuilderCardArt card={card} />
                  <strong>{card.name}</strong>
                  <span>{cardLabel(card)}</span>
                  <span>{slot} · {card.rarity ?? 'No rarity'}</span>
                  {mint ? (
                    <a className="booster-mint-link" href={`https://solscan.io/token/${mint.mintAddress}`} target="_blank" rel="noreferrer">
                      NFT {shortAddr(mint.mintAddress)} ↗
                    </a>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {activeTab === 'shop' && (
        <div className="profile-tab-pane">
          <BoosterFiltersBar
            search={filter}
            filter={filterMode}
            sort={sortMode}
            onSearch={setFilter}
            onFilter={setFilterMode}
            onSort={setSortMode}
          />
          {filteredSets.length === 0 ? (
            <BoosterEmptyState
              title="No booster sets match your search"
              description="Try clearing your filters or searching for a different era."
              actionLabel="Clear filters"
              onAction={() => { setFilter(''); setFilterMode('all'); setSortMode('newest'); }}
            />
          ) : (
            erasGrouped.map((group) => (
              <BoosterEraSection
                key={group.era.id}
                era={group.era}
                sets={group.sets}
                profile={profile}
                cardLibrary={CARD_LIBRARY as Record<string, Card>}
                priceLabel={PACK_PRICE_LABEL}
                buyingSetId={buyingSetId}
                onBuy={(set) => buyPackForSet(set as BoosterableSet)}
              />
            ))
          )}
        </div>
      )}

      {activeTab === 'open-packs' && (
        <div className="profile-tab-pane">
          <RecentOpeningsTab
            profile={profile}
            cardLibrary={CARD_LIBRARY as Record<string, Card>}
            setMetaById={BOOSTERABLE_SET_BY_ID as Map<string, SetMetaLike & { logo?: string }>}
            onBuyAgain={handleBuyAgain}
            buyingSetId={buyingSetId}
            priceLabel={PACK_PRICE_LABEL}
          />
        </div>
      )}

      {activeTab === 'collection' && (
        <div className="profile-tab-pane">
          <CollectionTab profile={profile} totalUniqueCardsInLibrary={totalUniqueCardsInLibrary} />
        </div>
      )}
    </main>
  );
}

function GymChallengePage({ profile, onExit }: { profile: ProfileState; onExit: () => void }) {
  const deckOptions = useMemo(() => deckOptionsForProfile(profile), [profile]);
  const [deckId, setDeckId] = useState(() => firstValidDeckId(deckOptions));
  const walletAddress = profile.wallet?.address;
  const [progress, setProgress] = useState<CampaignProgress>(() => loadCampaignProgress(walletAddress));
  const [activeMatch, setActiveMatch] = useState<{
    seed: string;
    playerDeck: DeckPayload;
    opponent: CampaignOpponent;
  } | null>(null);
  const [victoryAward, setVictoryAward] = useState<CampaignOpponent | null>(null);

  const selectedDeck = deckOptionById(deckOptions, deckId);
  const recommended = useMemo(() => recommendedNext(progress), [progress]);

  // Re-load progress whenever the active wallet changes (e.g. after sign-in).
  useEffect(() => {
    setProgress(loadCampaignProgress(walletAddress));
  }, [walletAddress]);

  function handleBattle(opponent: CampaignOpponent) {
    if (!selectedDeck || selectedDeck.issues.length > 0) return;
    const botCardIds = STARTER_DECKS[opponent.deckType];
    setActiveMatch({
      seed: `gym-${opponent.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      playerDeck: { cardIds: selectedDeck.cardIds, label: selectedDeck.label },
      opponent,
    });
  }

  function recordCampaignMatchComplete(opponent: CampaignOpponent, payload: { winner?: PlayerID }) {
    if (payload.winner !== '0') return; // player is always seat 0 in CPU matches
    const wasAlreadyDefeated = progress.defeatedOpponents.includes(opponent.id);
    const next = applyWin(progress, opponent);
    if (next === progress) return;
    setProgress(next);
    saveCampaignProgress(walletAddress, next);
    if (!wasAlreadyDefeated) setVictoryAward(opponent);
  }

  const CampaignBattleBoard = useMemo(() => {
    if (!activeMatch) return null;
    const opponent = activeMatch.opponent;
    const baseSetup = PokemonTCG.setup;
    if (!baseSetup) return null;
    const setupData: MatchSetupData = {
      matchName: `${profile.name} vs ${opponent.name}`,
      matchType: 'Casual',
      wagerCurrency: 'SOL',
      seedDecks: { '0': activeMatch.playerDeck.cardIds, '1': STARTER_DECKS[opponent.deckType] },
      deckLabels: { '0': activeMatch.playerDeck.label, '1': `${opponent.name} (${opponent.themeLabel})` },
    };
    const customisedGame = {
      ...PokemonTCG,
      setup: (ctx: Parameters<typeof baseSetup>[0]) => baseSetup(ctx, setupData),
    };
    const Board = (props: BoardProps<PokemonTCGState>) => (
      <PokemonBoard
        {...props}
        playerName={profile.name}
        playerWallet={walletAddress}
        selectedDeck={activeMatch.playerDeck}
        onMatchComplete={({ winner }) => recordCampaignMatchComplete(opponent, { winner })}
      />
    );
    return Client({
      game: customisedGame,
      board: Board,
      numPlayers: 2,
      multiplayer: Local({ bots: { '1': RandomBot } }),
      loading: () => <div className="match-loading">Loading {opponent.name}'s gym...</div>,
      debug: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMatch, profile.name, walletAddress]);

  if (activeMatch && CampaignBattleBoard) {
    return (
      <div className="match-screen">
        <div className="viewer-switch">
          <button onClick={() => setActiveMatch(null)}>← Exit gym</button>
          <span className="viewer-match-title">{profile.name} vs {activeMatch.opponent.name}</span>
          <span className="match-type-badge match-type-badge-Casual">{activeMatch.opponent.tier === 'champion' ? 'CHAMPION' : activeMatch.opponent.tier === 'elite-four' ? 'ELITE FOUR' : 'GYM'}</span>
          <span className="campaign-intro-line">"{activeMatch.opponent.introDialogue}"</span>
        </div>
        <CampaignBattleBoard matchID={activeMatch.seed} playerID="0" />
        {victoryAward && (
          <VictoryRewardModal
            opponent={victoryAward}
            onDismiss={() => { setVictoryAward(null); setActiveMatch(null); }}
          />
        )}
      </div>
    );
  }

  return (
    <main className="content-page gym-challenge-page">
      <div className="gym-challenge-header">
        <button onClick={onExit}>← Home</button>
        <DeckSelect title="Your deck" value={deckId} options={deckOptions} onChange={setDeckId} />
      </div>
      {selectedDeck?.issues.length ? (
        <ul className="issues">{selectedDeck.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
      ) : null}

      <CampaignHero progress={progress} recommended={recommended} />
      <BadgeCase progress={progress} />
      <CampaignRewardsPanel progress={progress} />
      <GymRow progress={progress} onBattle={handleBattle} />
      <EliteFourPanel progress={progress} onBattle={handleBattle} />
      <ChampionPanel progress={progress} onBattle={handleBattle} />

      {victoryAward && (
        <VictoryRewardModal opponent={victoryAward} onDismiss={() => setVictoryAward(null)} />
      )}
    </main>
  );
}

function ImportPage({ profile, onProfileChange }: { profile: ProfileState; onProfileChange: (profile: ProfileState) => void }) {
  const walletAddress = profile.wallet?.chain === 'solana' ? profile.wallet.address : undefined;
  const alreadyImported = useMemo(
    () => new Set((profile.importedNfts ?? []).map((entry) => entry.mintAddress)),
    [profile.importedNfts],
  );
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [scanError, setScanError] = useState('');
  const [status, setStatus] = useState('');
  const [scannedAddress, setScannedAddress] = useState<string | null>(null);

  async function scan() {
    if (!walletAddress) {
      setScanError('Connect a Solana wallet on sign-in before scanning.');
      return;
    }
    setScanError('');
    setStatus('');
    setScanning(true);
    try {
      const response = await scanWalletForImports(walletAddress);
      setCandidates(response.candidates);
      setScannedAddress(response.ownerAddress);
      const presets = new Set<string>();
      for (const candidate of response.candidates) {
        if (candidate.cardId && !alreadyImported.has(candidate.mintAddress) && candidate.confidence !== 'fuzzy-match') {
          presets.add(candidate.mintAddress);
        }
      }
      setSelected(presets);
      setStatus(`Found ${response.candidates.length} NFT${response.candidates.length === 1 ? '' : 's'} in your wallet.`);
    } catch (err) {
      setScanError(`Wallet scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
    }
  }

  async function importSelected() {
    const toImport = candidates.filter((c) =>
      selected.has(c.mintAddress)
      && c.cardId
      && !alreadyImported.has(c.mintAddress),
    );
    if (toImport.length === 0) {
      setScanError('Nothing to import. Select at least one matched NFT first.');
      return;
    }
    setScanError('');
    setImporting(true);
    try {
      const cardIds = toImport.map((c) => c.cardId!);
      const newRecords: ImportedNftRecord[] = toImport.map((c) => ({
        mintAddress: c.mintAddress,
        cardId: c.cardId!,
        cardName: c.cardName ?? c.nftName,
        importedAt: new Date().toISOString(),
        confidence: c.confidence === 'none' ? 'fuzzy-match' : c.confidence,
      }));
      const updated: ProfileState = {
        ...profile,
        ownedCards: addCardsToCollection(profile.ownedCards, cardIds),
        importedNfts: [...(profile.importedNfts ?? []), ...newRecords],
      };
      const saved = await persistAndStore(updated);
      onProfileChange(saved);
      setSelected(new Set());
      setStatus(`Imported ${toImport.length} card${toImport.length === 1 ? '' : 's'} into your collection.`);
    } catch (err) {
      setScanError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  }

  function toggle(mintAddress: string, cardId: string | undefined) {
    if (!cardId) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(mintAddress)) next.delete(mintAddress);
      else next.add(mintAddress);
      return next;
    });
  }

  const importableCount = candidates.filter((c) => c.cardId && !alreadyImported.has(c.mintAddress)).length;

  return (
    <main className="content-page imports-page">
      <section className="panel imports-panel">
        <p className="eyebrow">Import</p>
        <h1>Bring your phygitals on-chain into the game</h1>
        <p>
          Scan your connected Solana wallet for Pokemon NFTs (Collector Crypt phygitals, your own
          booster pulls from this app, and any other NFT with Pokemon-card metadata). Pick which
          to import and we'll add them to your in-game collection so they show up in the deckbuilder.
        </p>
        <div className="imports-stats">
          <span>Wallet: <strong>{walletAddress ? shortAddr(walletAddress) : 'not connected'}</strong></span>
          <span>Already imported: <strong>{(profile.importedNfts ?? []).length}</strong></span>
          {scannedAddress && <span>Last scan: <strong>{shortAddr(scannedAddress)}</strong></span>}
        </div>
        <div className="imports-actions">
          <button
            className="primary-cta"
            disabled={!walletAddress || scanning || importing}
            onClick={scan}
          >
            {scanning ? 'Scanning Helius...' : 'Scan my wallet'}
          </button>
          {candidates.length > 0 && (
            <button
              disabled={importing || selected.size === 0}
              onClick={importSelected}
            >
              {importing ? 'Importing...' : `Import ${selected.size} selected`}
            </button>
          )}
        </div>
        {status && <p className="success">{status}</p>}
        {scanError && <p className="error">{scanError}</p>}
        {!walletAddress && <p className="action-hint">Sign in with a Solana wallet to enable scanning.</p>}
      </section>

      {candidates.length > 0 && (
        <section className="panel imports-results">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Scan results</p>
              <h2>{candidates.length} NFT{candidates.length === 1 ? '' : 's'} · {importableCount} importable</h2>
              <p className="section-subtitle">Auto-selected matches are highest confidence. Uncheck anything that doesn't look right.</p>
            </div>
          </div>
          <div className="imports-grid">
            {candidates.map((candidate) => {
              const isImported = alreadyImported.has(candidate.mintAddress);
              const canImport = Boolean(candidate.cardId) && !isImported;
              const isSelected = selected.has(candidate.mintAddress);
              return (
                <article
                  className={`imports-card imports-card-${candidate.confidence} ${isImported ? 'imports-card-already' : ''} ${isSelected ? 'imports-card-selected' : ''}`}
                  key={candidate.mintAddress}
                >
                  <header className="imports-card-header">
                    <span className={`imports-confidence imports-confidence-${candidate.confidence}`}>
                      {candidate.confidence === 'app-mint' ? 'Booster pack mint'
                        : candidate.confidence === 'attribute-match' ? 'Attribute match'
                          : candidate.confidence === 'fuzzy-match' ? 'Fuzzy match'
                            : 'No match'}
                    </span>
                    {isImported && <span className="imports-already-tag">Already imported</span>}
                  </header>
                  <div className="imports-card-art">
                    {candidate.cardImage ? (
                      <img src={candidate.cardImage} alt={candidate.cardName ?? candidate.nftName} loading="lazy" />
                    ) : candidate.nftImage ? (
                      <img src={candidate.nftImage} alt={candidate.nftName} loading="lazy" />
                    ) : (
                      <div className="imports-card-art-placeholder">no image</div>
                    )}
                  </div>
                  <div className="imports-card-meta">
                    <strong>{candidate.cardName ?? candidate.nftName}</strong>
                    <span>{candidate.cardId ?? 'No matching card found'}</span>
                    <a
                      className="imports-card-mint"
                      href={`https://solscan.io/token/${candidate.mintAddress}`}
                      target="_blank"
                      rel="noreferrer"
                      title={candidate.mintAddress}
                    >
                      Mint {shortAddr(candidate.mintAddress)} ↗
                    </a>
                  </div>
                  <label className="imports-card-toggle">
                    <input
                      type="checkbox"
                      disabled={!canImport}
                      checked={isSelected}
                      onChange={() => toggle(candidate.mintAddress, candidate.cardId)}
                    />
                    <span>{isImported ? 'Already in collection' : canImport ? 'Import this card' : 'Cannot match'}</span>
                  </label>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {(profile.importedNfts ?? []).length > 0 && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">History</p>
              <h2>{profile.importedNfts!.length} imported card{profile.importedNfts!.length === 1 ? '' : 's'}</h2>
            </div>
          </div>
          <ul className="imports-history">
            {[...profile.importedNfts!].reverse().slice(0, 25).map((record) => (
              <li key={record.mintAddress}>
                <strong>{record.cardName}</strong>
                <span>{record.cardId}</span>
                <span>{new Date(record.importedAt).toLocaleString()}</span>
                <a href={`https://solscan.io/token/${record.mintAddress}`} target="_blank" rel="noreferrer">
                  {shortAddr(record.mintAddress)} ↗
                </a>
              </li>
            ))}
          </ul>
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
  const [prizeClaim, setPrizeClaim] = useState<ClaimedPrize | null>(null);
  const recordMatchCompletion = useCallback(async ({ reason, winner, winnerWallet }: { reason?: string; winner?: PlayerID; winnerWallet?: string }) => {
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
      matchType: config.matchType,
      playerID: config.playerID,
      playerDeckLabel: config.playerDeckLabel,
      opponentDeckLabel: config.opponentDeckLabel,
      wagerAmount: config.wagerAmount > 0 ? config.wagerAmount : undefined,
      wagerCurrency: config.wagerAmount > 0 ? config.wagerCurrency : undefined,
      result,
      winner,
      winnerWallet,
      reason,
      startedAt: startedRecord?.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const saved = await persistMatchAndStore(profile, record);
    onProfileChange(saved);

    // Free prize card for winning. Server enforces once-per-match via
    // app_match_records.prize_claimed. Skip if the player didn't sign
    // in with a Solana wallet — we have nothing to mint to.
    if (result !== 'win') return;
    const winnerWalletAddress = config.playerWallet ?? (profile.wallet?.chain === 'solana' ? profile.wallet.address : undefined);
    if (!winnerWalletAddress) return;
    try {
      const claim = await claimMatchPrize({
        matchID: config.matchID,
        walletAddress: winnerWalletAddress,
        playerID: config.playerID,
      });
      setPrizeClaim(claim);
      if (claim.card && !claim.alreadyClaimed) {
        const updated: ProfileState = {
          ...saved,
          ownedCards: addCardsToCollection(saved.ownedCards, [claim.card.id]),
        };
        const persistedWithPrize = await persistProfile(updated);
        onProfileChange(persistedWithPrize);
      }
    } catch (err) {
      console.warn('[prize] claim failed', err);
    }
  }, [config.matchID, config.matchType, config.opponentDeckLabel, config.playerDeckLabel, config.playerID, config.playerWallet, config.wagerAmount, config.wagerCurrency, onProfileChange, profile, recordedGameover]);

  const MatchBoard = useMemo(() => (
    function MatchBoard(props: BoardProps<PokemonTCGState>) {
      return (
        <PokemonBoard
          {...props}
          onMatchComplete={recordMatchCompletion}
          prizeClaim={prizeClaim}
          selectedDeck={config.playerDeck}
          playerWallet={config.playerWallet}
          playerName={profile.name}
        />
      );
    }
  ), [config.playerDeck, config.playerWallet, prizeClaim, profile.name, recordMatchCompletion]);

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
        <button onClick={onExit}>← Exit match</button>
        <span className="viewer-match-title">{config.matchName}</span>
        <span className={`match-type-badge match-type-badge-${config.matchType}`}>{config.matchType}</span>
        <span className="match-id-chip">#{config.matchID.slice(0, 8)}</span>
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
  const [page, setPage] = useState<Page>(() => {
    const stored = loadProfile();
    // Wallet-less profiles get bounced back to sign-in even if their name is
    // cached — the arena is wallet-only now.
    return stored.name && stored.wallet && !isReservedName(stored.name) ? 'home' : 'signin';
  });
  const [matchConfig, setMatchConfig] = useState<MatchConfig | null>(null);

  // Initialise the Telegram Mini App once (expand viewport, apply theme
  // colors, mark <html> with .telegram-mini-app). Outside Telegram this
  // is a no-op so normal browser behaviour is unaffected.
  useEffect(() => {
    initTelegramWebApp();
  }, []);

  // Telegram BackButton -> in-app navigation. Sub-pages show it so the
  // user can back out without leaving the mini app. Top-level pages
  // (home, signin) hide it.
  useEffect(() => {
    if (!isTelegramMiniApp()) return;
    if (page === 'signin' || page === 'home') return;
    const backTarget: Page = page === 'match' || page === 'bot' ? 'home' : 'home';
    const unsubscribe = showTelegramBackButton(() => {
      if (page === 'match') setMatchConfig(null);
      setPage(backTarget);
    });
    return unsubscribe;
  }, [page]);

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

  const isInMatch = (page === 'match' && Boolean(matchConfig)) || page === 'bot';
  const musicSrc = isInMatch ? '/battle-music.mp3' : '/menu-music.mp3';
  const musicLabel = isInMatch ? 'battle music' : 'menu music';
  const music = <BackgroundMusicPlayer src={musicSrc} label={musicLabel} paused={false} />;

  if (page === 'signin' || !profile.name || !profile.wallet || isReservedName(profile.name)) {
    return (
      <>
        {music}
        <SignInPage onSignIn={(next) => { setProfile(next); setPage('home'); }} />
      </>
    );
  }

  if (page === 'match' && matchConfig) {
    return (
      <>
        {music}
        <MatchClient
          config={matchConfig}
          onExit={() => { setMatchConfig(null); setPage('home'); }}
          onProfileChange={updateProfile}
          profile={profile}
        />
      </>
    );
  }

  if (page === 'bot') {
    return (
      <>
        {music}
        <GymChallengePage profile={profile} onExit={() => setPage('home')} />
      </>
    );
  }

  return (
    <>
      {music}
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
        {page === 'imports' && <ImportPage profile={profile} onProfileChange={updateProfile} />}
        {page === 'home' && <HomePage profile={profile} onNavigate={setPage} />}
      </Shell>
    </>
  );
}
