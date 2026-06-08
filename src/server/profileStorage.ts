import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import type { MatchLeaderboardEntry, MatchRecord, PackPurchase, ProfileState, StoredProfile } from '../shared/profile';
import { loginKeyForProfile, maxCollections } from '../shared/profile';

export interface ProfileStorage {
  connect(): Promise<void>;
  login(profile: ProfileState): Promise<StoredProfile>;
  saveProfile(userId: string, profile: ProfileState): Promise<StoredProfile>;
  recordPack(userId: string, purchase: PackPurchase, profile: ProfileState): Promise<StoredProfile>;
  recordMatch(userId: string, record: MatchRecord): Promise<StoredProfile>;
  listLeaderboard(): Promise<MatchLeaderboardEntry[]>;
  /** Daily-window leaderboard. Filters completed matches by `started_at >=
   *  dateKey midnight UTC AND started_at < next midnight UTC`. dateKey is
   *  YYYY-MM-DD; defaults to today (UTC). */
  listDailyLeaderboard?(dateKey: string): Promise<MatchLeaderboardEntry[]>;
  /** Settle yesterday's daily-leaderboard rewards exactly once. Returns
   *  the persisted top-3 (rank 1/2/3 winners). Idempotent per dateKey:
   *  subsequent calls return the same rows. */
  settleDailyLeaderboard?(dateKey: string): Promise<DailyLeaderboardReward[]>;
  /** Look up any unclaimed daily-leaderboard rewards for this user
   *  across ALL past date keys. Used to render the "Claim trainer
   *  pack" CTA on the leaderboard tab. */
  listUnclaimedDailyRewards?(userId: string): Promise<DailyLeaderboardReward[]>;
  /** Idempotently grant the trainer-pack to the named winner. Atomically
   *  flips claimed_at + records the pack purchase + bumps ownedCards. */
  claimDailyLeaderboardReward?(userId: string, dateKey: string, rank: number, cardIds: string[]): Promise<{ profile: StoredProfile; purchase: PackPurchase; alreadyClaimed: boolean }>;
  findProfileByWallet?(walletAddress: string): Promise<StoredProfile | undefined>;
  findProfileByUserId?(userId: string): Promise<StoredProfile | undefined>;
  reservePrizeClaim?(userId: string, matchID: string, playerID: string): Promise<{
    eligible: boolean;
    reason?: string;
    alreadyClaimed?: { cardId: string; mintAddress?: string; signature?: string };
  }>;
  recordPrizeClaim?(userId: string, matchID: string, playerID: string, prize: { cardId: string; mintAddress?: string; signature?: string }): Promise<void>;
  /** Atomically claim the user's daily-free-pack reward. */
  claimDailyPack?(userId: string, cardIds: string[], cooldownMs: number): Promise<{ profile: StoredProfile; purchase: PackPurchase }>;
  /** Idempotently redeem a token-burn signature for a pack. The
   *  signature acts as the natural unique key so replaying the same
   *  burn tx returns the existing PackPurchase instead of granting
   *  another set of cards. Caller is responsible for verifying the
   *  burn on-chain BEFORE calling this method. */
  redeemBurnPack?(userId: string, signature: string, cardIds: string[]): Promise<{ profile: StoredProfile; purchase: PackPurchase; alreadyRedeemed: boolean }>;
  // ----- Champions Row daily lottery ---------------------------------------
  /** Return every stored profile that has the campaign-complete badge set
   *  (8 gym badges + 4 elite four + champion defeated). The server still
   *  re-checks live $POKETCG balance per profile before drawing. */
  listCampaignCompleteProfiles?(): Promise<StoredProfile[]>;
  /** Atomically read or roll today's Champions Row draw. Returns the
   *  existing draw if one already exists for today's date_key, otherwise
   *  inserts a fresh row using the resolver to produce (winner, cardIds)
   *  exactly once. Two concurrent calls on the same day return the same
   *  draw — the ON CONFLICT path no-ops and the second caller reads back
   *  the first inserted row. */
  ensureChampionsRowDraw?(
    dateKey: string,
    resolve: () => Promise<{ winnerUserId: string | null; winnerWallet: string | null; cardIds: string[]; eligibleCount: number; seed: string }>,
  ): Promise<ChampionsRowDraw>;
  /** Idempotently credit the winner with the rolled pack. Inserts a
   *  pack-purchase row keyed on the synthetic signature so a refresh
   *  doesn't double-grant. No-op (but returns the existing record) if
   *  already claimed. */
  claimChampionsRowDraw?(userId: string, dateKey: string): Promise<{ profile: StoredProfile; purchase: PackPurchase; alreadyClaimed: boolean } | { notWinner: true }>;
}

export interface DailyLeaderboardReward {
  dateKey: string;
  rank: number;
  userId: string;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  matches: number;
  cardIds: string[] | null;
  claimedAt: string | null;
}

export interface ChampionsRowDraw {
  dateKey: string;
  winnerUserId: string | null;
  winnerWallet: string | null;
  cardIds: string[];
  eligibleCount: number;
  seed: string;
  drawnAt: string;
  claimedAt: string | null;
}

const PROFILES_TABLE = 'app_profiles';
const PACKS_TABLE = 'app_pack_purchases';
const MATCHES_TABLE = 'app_match_records';
const CHAMPIONS_DRAWS_TABLE = 'app_champions_row_draws';
const DAILY_REWARDS_TABLE = 'app_daily_leaderboard_rewards';

function nowIso(): string {
  return new Date().toISOString();
}

/** Thrown by claimDailyPack when the user is still on cooldown.
 *  Carries the wall-clock time when the next claim becomes available. */
export class DailyPackCooldownError extends Error {
  nextClaimAt: string;
  constructor(nextClaimAt: string) {
    super(`Daily pack on cooldown until ${nextClaimAt}`);
    this.name = 'DailyPackCooldownError';
    this.nextClaimAt = nextClaimAt;
  }
}

function normalizeProfile(profile: ProfileState): ProfileState {
  return {
    ...profile,
    name: profile.name.trim() || 'PokemonTrainer',
    customDeck: Array.isArray(profile.customDeck) ? profile.customDeck : [],
    deckLibrary: Array.isArray(profile.deckLibrary) ? profile.deckLibrary : [],
    ownedCards: profile.ownedCards ?? {},
    packsOpened: Number.isFinite(profile.packsOpened) ? profile.packsOpened : 0,
    packPurchases: Array.isArray(profile.packPurchases) ? profile.packPurchases : [],
    matchRecords: Array.isArray(profile.matchRecords) ? profile.matchRecords : [],
    importedNfts: Array.isArray(profile.importedNfts) ? profile.importedNfts : [],
    lastDailyPackAt: typeof profile.lastDailyPackAt === 'string' ? profile.lastDailyPackAt : undefined,
    campaignProgress: profile.campaignProgress && typeof profile.campaignProgress === 'object'
      ? {
        earnedBadges: Array.isArray(profile.campaignProgress.earnedBadges)
          ? profile.campaignProgress.earnedBadges.filter((b) => typeof b === 'string')
          : [],
        defeatedOpponents: Array.isArray(profile.campaignProgress.defeatedOpponents)
          ? profile.campaignProgress.defeatedOpponents.filter((o) => typeof o === 'string')
          : [],
        championDefeated: Boolean(profile.campaignProgress.championDefeated),
      }
      : undefined,
  };
}

function mergeProfiles(existing: StoredProfile, incoming: ProfileState): StoredProfile {
  const normalized = normalizeProfile(incoming);
  const purchases = new Map(existing.packPurchases.map((purchase) => [purchase.signature || purchase.openedAt, purchase]));
  for (const purchase of normalized.packPurchases) {
    purchases.set(purchase.signature || purchase.openedAt, purchase);
  }

  const matches = new Map(existing.matchRecords.map((record) => [`${record.matchID}:${record.playerID}`, record]));
  for (const record of normalized.matchRecords) {
    matches.set(`${record.matchID}:${record.playerID}`, record);
  }
  const deckLibrary = new Map(existing.deckLibrary.map((deck) => [deck.id, deck]));
  for (const deck of normalized.deckLibrary) {
    deckLibrary.set(deck.id, deck);
  }
  const imports = new Map((existing.importedNfts ?? []).map((entry) => [entry.mintAddress, entry]));
  for (const entry of (normalized.importedNfts ?? [])) {
    imports.set(entry.mintAddress, entry);
  }

  return {
    ...existing,
    name: normalized.name,
    wallet: normalized.wallet,
    activeDeckName: normalized.activeDeckName || existing.activeDeckName,
    customDeck: normalized.customDeck.length > 0 ? normalized.customDeck : existing.customDeck,
    deckLibrary: [...deckLibrary.values()],
    ownedCards: maxCollections(existing.ownedCards, normalized.ownedCards),
    packsOpened: Math.max(existing.packsOpened, normalized.packsOpened, purchases.size),
    packPurchases: [...purchases.values()],
    matchRecords: [...matches.values()],
    importedNfts: [...imports.values()],
    // lastDailyPackAt is server-managed — claimDailyPack() updates
    // it atomically with a cooldown check. The client only reads it.
    lastDailyPackAt: existing.lastDailyPackAt,
    // campaignProgress is client-pushed (the campaign lives in
    // localStorage; the user can already replay it locally). Use the
    // incoming snapshot if present, otherwise preserve existing.
    campaignProgress: normalized.campaignProgress ?? existing.campaignProgress,
    updatedAt: nowIso(),
    lastLoginAt: nowIso(),
  };
}

function storedProfileFromRow(row: {
  active_deck_name: string;
  created_at: string;
  custom_deck: string[];
  deck_library: ProfileState['deckLibrary'] | null;
  imported_nfts: ProfileState['importedNfts'] | null;
  last_login_at: string;
  login_key: string;
  match_records: MatchRecord[] | null;
  name: string;
  owned_cards: Record<string, number>;
  pack_purchases: PackPurchase[] | null;
  packs_opened: number;
  last_daily_pack_at: string | null;
  campaign_progress: unknown;
  updated_at: string;
  user_id: string;
  wallet: ProfileState['wallet'];
}): StoredProfile {
  return {
    userId: row.user_id,
    loginKey: row.login_key,
    name: row.name,
    wallet: row.wallet,
    activeDeckName: row.active_deck_name,
    customDeck: row.custom_deck,
    deckLibrary: row.deck_library ?? [],
    ownedCards: row.owned_cards,
    packsOpened: row.packs_opened,
    packPurchases: row.pack_purchases ?? [],
    matchRecords: row.match_records ?? [],
    importedNfts: row.imported_nfts ?? [],
    lastDailyPackAt: row.last_daily_pack_at ?? undefined,
    campaignProgress: row.campaign_progress && typeof row.campaign_progress === 'object'
      ? row.campaign_progress as ProfileState['campaignProgress']
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export class PostgresProfileStorage implements ProfileStorage {
  private readonly pool: Pool;
  /**
   * ISO timestamp of the last leaderboard reset. Match records started
   * before this are silently dropped on persist so client caches can't
   * resurrect them after a wipe.
   */
  private readonly resetEpoch?: number;

  constructor(connectionString: string, ssl?: PoolConfig['ssl'], options?: { leaderboardResetAt?: string }) {
    this.pool = new Pool({ connectionString, ssl });
    const epochIso = options?.leaderboardResetAt;
    if (epochIso) {
      const parsed = Date.parse(epochIso);
      this.resetEpoch = Number.isFinite(parsed) ? parsed : undefined;
      if (this.resetEpoch) {
        console.log(`[profile-storage] leaderboard reset epoch active: ${new Date(this.resetEpoch).toISOString()} — match records started before this will be dropped on persist.`);
      } else {
        console.warn(`[profile-storage] LEADERBOARD_RESET_AT="${epochIso}" is not a valid ISO timestamp, ignoring.`);
      }
    }
  }

  private isBeforeReset(record: MatchRecord): boolean {
    if (!this.resetEpoch) return false;
    const started = Date.parse(record.startedAt);
    return Number.isFinite(started) && started < this.resetEpoch;
  }

  async connect(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${PROFILES_TABLE} (
        user_id TEXT PRIMARY KEY,
        login_key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        wallet JSONB,
        active_deck_name TEXT NOT NULL,
        custom_deck JSONB NOT NULL,
        deck_library JSONB NOT NULL DEFAULT '[]'::jsonb,
        owned_cards JSONB NOT NULL,
        packs_opened INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_login_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query(`ALTER TABLE ${PROFILES_TABLE} ADD COLUMN IF NOT EXISTS deck_library JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await this.pool.query(`ALTER TABLE ${PROFILES_TABLE} ADD COLUMN IF NOT EXISTS imported_nfts JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await this.pool.query(`ALTER TABLE ${PROFILES_TABLE} ADD COLUMN IF NOT EXISTS last_daily_pack_at TIMESTAMPTZ`);
    await this.pool.query(`ALTER TABLE ${PROFILES_TABLE} ADD COLUMN IF NOT EXISTS campaign_progress JSONB`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${PACKS_TABLE} (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES ${PROFILES_TABLE}(user_id) ON DELETE CASCADE,
        signature TEXT NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL,
        card_ids JSONB NOT NULL,
        UNIQUE (user_id, signature)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${MATCHES_TABLE} (
        user_id TEXT NOT NULL REFERENCES ${PROFILES_TABLE}(user_id) ON DELETE CASCADE,
        match_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        player_deck_label TEXT NOT NULL,
        opponent_deck_label TEXT NOT NULL,
        result TEXT NOT NULL,
        winner TEXT,
        reason TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (user_id, match_id, player_id)
      )
    `);
    // Backfill columns for older rows so leaderboard / wager UI can read them.
    await this.pool.query(`ALTER TABLE ${MATCHES_TABLE} ADD COLUMN IF NOT EXISTS match_type TEXT NOT NULL DEFAULT 'Ranked'`);
    await this.pool.query(`ALTER TABLE ${MATCHES_TABLE} ADD COLUMN IF NOT EXISTS wager_amount NUMERIC`);
    await this.pool.query(`ALTER TABLE ${MATCHES_TABLE} ADD COLUMN IF NOT EXISTS wager_currency TEXT`);
    await this.pool.query(`ALTER TABLE ${MATCHES_TABLE} ADD COLUMN IF NOT EXISTS winner_wallet TEXT`);
    await this.pool.query(`ALTER TABLE ${MATCHES_TABLE} ADD COLUMN IF NOT EXISTS prize_claimed BOOLEAN NOT NULL DEFAULT FALSE`);
    await this.pool.query(`ALTER TABLE ${MATCHES_TABLE} ADD COLUMN IF NOT EXISTS prize_card_id TEXT`);
    await this.pool.query(`ALTER TABLE ${MATCHES_TABLE} ADD COLUMN IF NOT EXISTS prize_mint_address TEXT`);
    await this.pool.query(`ALTER TABLE ${MATCHES_TABLE} ADD COLUMN IF NOT EXISTS prize_mint_signature TEXT`);

    // Champions Row daily-lottery draws. One row per (date_key) — the
    // PRIMARY KEY makes ensureChampionsRowDraw idempotent via
    // ON CONFLICT DO NOTHING.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${CHAMPIONS_DRAWS_TABLE} (
        date_key TEXT PRIMARY KEY,
        winner_user_id TEXT REFERENCES ${PROFILES_TABLE}(user_id) ON DELETE SET NULL,
        winner_wallet TEXT,
        card_ids JSONB NOT NULL,
        eligible_count INTEGER NOT NULL,
        seed TEXT NOT NULL,
        drawn_at TIMESTAMPTZ NOT NULL,
        claimed_at TIMESTAMPTZ
      )
    `);
    // Daily-leaderboard trainer-pack rewards. (date_key, rank) PK
    // makes settleDailyLeaderboard idempotent.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${DAILY_REWARDS_TABLE} (
        date_key TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK (rank IN (1, 2, 3)),
        user_id TEXT NOT NULL REFERENCES ${PROFILES_TABLE}(user_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        wins INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        draws INTEGER NOT NULL,
        matches INTEGER NOT NULL,
        card_ids JSONB,
        settled_at TIMESTAMPTZ NOT NULL,
        claimed_at TIMESTAMPTZ,
        PRIMARY KEY (date_key, rank)
      )
    `);
  }

  async login(profile: ProfileState): Promise<StoredProfile> {
    const loginKey = loginKeyForProfile(profile);
    const existing = await this.findByLoginKey(loginKey);
    if (existing) {
      return this.saveStoredProfile(mergeProfiles(existing, profile));
    }

    const timestamp = nowIso();
    return this.saveStoredProfile({
      ...normalizeProfile(profile),
      userId: randomUUID(),
      loginKey,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: timestamp,
    });
  }

  async saveProfile(userId: string, profile: ProfileState): Promise<StoredProfile> {
    const existing = await this.findByUserId(userId);
    if (!existing) {
      throw new Error(`Profile not found: ${userId}`);
    }
    return this.saveStoredProfile({
      ...existing,
      ...normalizeProfile(profile),
      userId,
      loginKey: existing.loginKey,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
      lastLoginAt: existing.lastLoginAt,
    });
  }

  async recordPack(userId: string, purchase: PackPurchase, profile: ProfileState): Promise<StoredProfile> {
    await this.pool.query(
      `
        INSERT INTO ${PACKS_TABLE} (user_id, signature, opened_at, card_ids)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (user_id, signature)
        DO UPDATE SET opened_at = EXCLUDED.opened_at, card_ids = EXCLUDED.card_ids
      `,
      [userId, purchase.signature, purchase.openedAt, JSON.stringify(purchase.cardIds)],
    );
    return this.saveProfile(userId, profile);
  }

  async recordMatch(userId: string, record: MatchRecord): Promise<StoredProfile> {
    if (this.isBeforeReset(record)) {
      // Silently drop pre-reset records (e.g. stale records pushed up by a
      // client that still has them cached locally). Returning the current
      // profile keeps the client's persist call from breaking.
      const existing = await this.findByUserId(userId);
      if (!existing) throw new Error(`Profile not found: ${userId}`);
      return existing;
    }
    await this.pool.query(
      `
        INSERT INTO ${MATCHES_TABLE}
          (user_id, match_id, player_id, player_deck_label, opponent_deck_label, result, winner, reason, started_at, completed_at, match_type, wager_amount, wager_currency, winner_wallet)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (user_id, match_id, player_id)
        DO UPDATE SET
          player_deck_label = EXCLUDED.player_deck_label,
          opponent_deck_label = EXCLUDED.opponent_deck_label,
          result = EXCLUDED.result,
          winner = EXCLUDED.winner,
          reason = EXCLUDED.reason,
          completed_at = EXCLUDED.completed_at,
          match_type = EXCLUDED.match_type,
          wager_amount = EXCLUDED.wager_amount,
          wager_currency = EXCLUDED.wager_currency,
          winner_wallet = EXCLUDED.winner_wallet
      `,
      [
        userId,
        record.matchID,
        record.playerID,
        record.playerDeckLabel,
        record.opponentDeckLabel,
        record.result,
        record.winner,
        record.reason,
        record.startedAt,
        record.completedAt,
        record.matchType ?? 'Ranked',
        record.wagerAmount ?? null,
        record.wagerCurrency ?? null,
        record.winnerWallet ?? null,
      ],
    );

    const existing = await this.findByUserId(userId);
    if (!existing) {
      throw new Error(`Profile not found: ${userId}`);
    }
    const records = new Map(existing.matchRecords.map((candidate) => [`${candidate.matchID}:${candidate.playerID}`, candidate]));
    records.set(`${record.matchID}:${record.playerID}`, record);
    return this.saveStoredProfile({ ...existing, matchRecords: [...records.values()], updatedAt: nowIso() });
  }

  async listLeaderboard(): Promise<MatchLeaderboardEntry[]> {
    // Every completed match counts toward the W/L record on the
    // leaderboard, regardless of matchType (Casual, Ranked, Wager) or
    // whether the opponent was a human or a CPU/gym leader. INNER JOIN
    // + HAVING keeps profiles with zero completed matches out of the
    // leaderboard so it doesn't show every signed-up user at 0/0/0/0.
    const { rows } = await this.pool.query<MatchLeaderboardEntry>(`
      SELECT
        p.user_id AS "userId",
        p.name,
        COUNT(*) FILTER (WHERE m.result IN ('win', 'loss', 'draw'))::int AS matches,
        COUNT(*) FILTER (WHERE m.result = 'win')::int AS wins,
        COUNT(*) FILTER (WHERE m.result = 'loss')::int AS losses,
        COUNT(*) FILTER (WHERE m.result = 'draw')::int AS draws
      FROM ${PROFILES_TABLE} p
      INNER JOIN ${MATCHES_TABLE} m ON m.user_id = p.user_id
      GROUP BY p.user_id, p.name
      HAVING COUNT(*) FILTER (WHERE m.result IN ('win', 'loss', 'draw')) > 0
      ORDER BY wins DESC, losses ASC, draws DESC, matches DESC, p.name ASC
      LIMIT 50
    `);
    return rows;
  }

  async listDailyLeaderboard(dateKey: string): Promise<MatchLeaderboardEntry[]> {
    // Same shape as listLeaderboard but filtered to a single UTC day.
    // started_at is the per-match timestamp, so a match started before
    // midnight UTC and finished after does NOT count for the next day.
    const { rows } = await this.pool.query<MatchLeaderboardEntry>(`
      SELECT
        p.user_id AS "userId",
        p.name,
        COUNT(*) FILTER (WHERE m.result IN ('win', 'loss', 'draw'))::int AS matches,
        COUNT(*) FILTER (WHERE m.result = 'win')::int AS wins,
        COUNT(*) FILTER (WHERE m.result = 'loss')::int AS losses,
        COUNT(*) FILTER (WHERE m.result = 'draw')::int AS draws
      FROM ${PROFILES_TABLE} p
      INNER JOIN ${MATCHES_TABLE} m ON m.user_id = p.user_id
      WHERE m.started_at >= ($1::date AT TIME ZONE 'UTC')
        AND m.started_at <  ($1::date + INTERVAL '1 day') AT TIME ZONE 'UTC'
      GROUP BY p.user_id, p.name
      HAVING COUNT(*) FILTER (WHERE m.result IN ('win', 'loss', 'draw')) > 0
      ORDER BY wins DESC, losses ASC, draws DESC, matches DESC, p.name ASC
      LIMIT 50
    `, [dateKey]);
    return rows;
  }

  async settleDailyLeaderboard(dateKey: string): Promise<DailyLeaderboardReward[]> {
    // Idempotent: if rows already exist for this dateKey, return them as-is.
    const existing = await this.pool.query(
      `SELECT * FROM ${DAILY_REWARDS_TABLE} WHERE date_key = $1 ORDER BY rank ASC`,
      [dateKey],
    );
    if (existing.rows.length > 0) {
      return existing.rows.map(this.rowToDailyReward);
    }
    // Roll the top 3 from yesterday's leaderboard. settled_at is now;
    // claimed_at stays null until the winner clicks Claim.
    const top = await this.listDailyLeaderboard(dateKey);
    const winners = top.slice(0, 3);
    if (winners.length === 0) return [];
    const settledAt = nowIso();
    for (let i = 0; i < winners.length; i += 1) {
      const w = winners[i]!;
      await this.pool.query(
        `INSERT INTO ${DAILY_REWARDS_TABLE}
           (date_key, rank, user_id, name, wins, losses, draws, matches, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (date_key, rank) DO NOTHING`,
        [dateKey, i + 1, w.userId, w.name, w.wins, w.losses, w.draws, w.matches, settledAt],
      );
    }
    const reread = await this.pool.query(
      `SELECT * FROM ${DAILY_REWARDS_TABLE} WHERE date_key = $1 ORDER BY rank ASC`,
      [dateKey],
    );
    return reread.rows.map(this.rowToDailyReward);
  }

  async listUnclaimedDailyRewards(userId: string): Promise<DailyLeaderboardReward[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${DAILY_REWARDS_TABLE} WHERE user_id = $1 AND claimed_at IS NULL ORDER BY date_key DESC, rank ASC`,
      [userId],
    );
    return rows.map(this.rowToDailyReward);
  }

  async claimDailyLeaderboardReward(
    userId: string,
    dateKey: string,
    rank: number,
    cardIds: string[],
  ): Promise<{ profile: StoredProfile; purchase: PackPurchase; alreadyClaimed: boolean }> {
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      throw new Error('claimDailyLeaderboardReward requires cardIds');
    }
    const signature = `daily-leaderboard:${dateKey}:rank-${rank}`;
    // Replay short-circuit on existing pack purchase.
    const existingPack = await this.pool.query<{ opened_at: string; card_ids: string[] }>(
      `SELECT opened_at, card_ids FROM ${PACKS_TABLE} WHERE user_id = $1 AND signature = $2`,
      [userId, signature],
    );
    if (existingPack.rows.length > 0) {
      const profile = await this.findByUserId(userId);
      if (!profile) throw new Error(`Profile vanished: ${userId}`);
      const r = existingPack.rows[0]!;
      return { profile, purchase: { signature, openedAt: r.opened_at, cardIds: r.card_ids }, alreadyClaimed: true };
    }
    // Lock + verify the reward row matches the claimer.
    const rewardRow = await this.pool.query(
      `SELECT * FROM ${DAILY_REWARDS_TABLE} WHERE date_key = $1 AND rank = $2 FOR UPDATE`,
      [dateKey, rank],
    );
    if (rewardRow.rows.length === 0) throw new Error('No reward row for that (dateKey, rank)');
    if (rewardRow.rows[0].user_id !== userId) throw new Error("That reward isn't yours.");
    const now = nowIso();
    const profileRow = await this.pool.query<{ owned_cards: Record<string, number> }>(
      `SELECT owned_cards FROM ${PROFILES_TABLE} WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (profileRow.rows.length === 0) throw new Error(`Profile not found: ${userId}`);
    const ownedCards: Record<string, number> = { ...(profileRow.rows[0]!.owned_cards ?? {}) };
    for (const id of cardIds) ownedCards[id] = (ownedCards[id] ?? 0) + 1;
    await this.pool.query(
      `UPDATE ${PROFILES_TABLE}
       SET owned_cards = $2::jsonb, packs_opened = packs_opened + 1, updated_at = $3
       WHERE user_id = $1`,
      [userId, JSON.stringify(ownedCards), now],
    );
    await this.pool.query(
      `INSERT INTO ${PACKS_TABLE} (user_id, signature, opened_at, card_ids)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (user_id, signature) DO NOTHING`,
      [userId, signature, now, JSON.stringify(cardIds)],
    );
    await this.pool.query(
      `UPDATE ${DAILY_REWARDS_TABLE}
       SET claimed_at = $3, card_ids = $4::jsonb
       WHERE date_key = $1 AND rank = $2`,
      [dateKey, rank, now, JSON.stringify(cardIds)],
    );
    const profile = await this.findByUserId(userId);
    if (!profile) throw new Error(`Profile vanished: ${userId}`);
    return {
      profile,
      purchase: { signature, openedAt: now, cardIds: [...cardIds] },
      alreadyClaimed: false,
    };
  }

  private rowToDailyReward(row: {
    date_key: string; rank: number; user_id: string; name: string;
    wins: number; losses: number; draws: number; matches: number;
    card_ids: string[] | null; claimed_at: string | null;
  }): DailyLeaderboardReward {
    return {
      dateKey: row.date_key,
      rank: Number(row.rank),
      userId: row.user_id,
      name: row.name,
      wins: Number(row.wins),
      losses: Number(row.losses),
      draws: Number(row.draws),
      matches: Number(row.matches),
      cardIds: row.card_ids,
      claimedAt: row.claimed_at,
    };
  }

  private async findByLoginKey(loginKey: string): Promise<StoredProfile | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM ${PROFILES_TABLE} WHERE login_key = $1`, [loginKey]);
    return rows[0] ? storedProfileFromRow(rows[0]) : undefined;
  }

  async findProfileByUserId(userId: string): Promise<StoredProfile | undefined> {
    return this.findByUserId(userId);
  }

  private async findByUserId(userId: string): Promise<StoredProfile | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM ${PROFILES_TABLE} WHERE user_id = $1`, [userId]);
    return rows[0] ? storedProfileFromRow(rows[0]) : undefined;
  }

  // Used by the per-match prize endpoint to map a Solana wallet address
  // back to the StoredProfile (and its userId) so we can look up + update
  // the match record. wallet JSONB looks like `{ chain, address, label }`,
  // so we filter on the address subkey.
  async findProfileByWallet(walletAddress: string): Promise<StoredProfile | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${PROFILES_TABLE} WHERE wallet->>'address' = $1 ORDER BY last_login_at DESC LIMIT 1`,
      [walletAddress],
    );
    return rows[0] ? storedProfileFromRow(rows[0]) : undefined;
  }

  /**
   * Atomically check whether this (user, match, player) can claim a prize
   * and reserve the slot. Uses a single UPDATE with WHERE clauses so two
   * concurrent calls can't both mint a prize for the same match.
   *
   * Returns `{ eligible: true }` if the caller is now responsible for
   * rolling + minting and then calling `recordPrizeClaim`. Returns
   * `{ eligible: false, reason, alreadyClaimed? }` otherwise (no record,
   * not a win, or already claimed).
   */
  async reservePrizeClaim(userId: string, matchID: string, playerID: string): Promise<{
    eligible: boolean;
    reason?: string;
    alreadyClaimed?: { cardId: string; mintAddress?: string; signature?: string };
  }> {
    const existing = await this.pool.query(
      `SELECT result, prize_claimed, prize_card_id, prize_mint_address, prize_mint_signature
       FROM ${MATCHES_TABLE}
       WHERE user_id = $1 AND match_id = $2 AND player_id = $3`,
      [userId, matchID, playerID],
    );
    const row = existing.rows[0];
    if (!row) return { eligible: false, reason: 'no_match_record' };
    if (row.result !== 'win') return { eligible: false, reason: 'not_a_win' };
    if (row.prize_claimed) {
      return {
        eligible: false,
        reason: 'already_claimed',
        alreadyClaimed: row.prize_card_id ? {
          cardId: row.prize_card_id,
          mintAddress: row.prize_mint_address ?? undefined,
          signature: row.prize_mint_signature ?? undefined,
        } : undefined,
      };
    }
    return { eligible: true };
  }

  /**
   * Persist the rolled prize + mint info on the match record. Called by
   * the endpoint after `reservePrizeClaim` returned `eligible: true` and
   * the NFT mint has succeeded.
   */
  async recordPrizeClaim(
    userId: string,
    matchID: string,
    playerID: string,
    prize: { cardId: string; mintAddress?: string; signature?: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${MATCHES_TABLE}
       SET prize_claimed = TRUE,
           prize_card_id = $4,
           prize_mint_address = $5,
           prize_mint_signature = $6
       WHERE user_id = $1 AND match_id = $2 AND player_id = $3`,
      [userId, matchID, playerID, prize.cardId, prize.mintAddress ?? null, prize.signature ?? null],
    );
  }

  async claimDailyPack(
    userId: string,
    cardIds: string[],
    cooldownMs: number,
  ): Promise<{ profile: StoredProfile; purchase: PackPurchase }> {
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      throw new Error('claimDailyPack requires at least one cardId');
    }
    const now = nowIso();
    const cutoff = new Date(Date.now() - cooldownMs).toISOString();
    // Atomic cooldown check + reservation in a single UPDATE.
    // Zero rows returned => still on cooldown OR profile doesn't exist.
    const { rows } = await this.pool.query<{ owned_cards: Record<string, number>; packs_opened: number; last_daily_pack_at: string | null }>(
      `UPDATE ${PROFILES_TABLE}
       SET last_daily_pack_at = $2, updated_at = $2
       WHERE user_id = $1
         AND (last_daily_pack_at IS NULL OR last_daily_pack_at < $3)
       RETURNING owned_cards, packs_opened, last_daily_pack_at`,
      [userId, now, cutoff],
    );
    if (rows.length === 0) {
      // Either no profile or cooldown active — disambiguate.
      const probe = await this.findByUserId(userId);
      if (!probe) throw new Error(`Profile not found: ${userId}`);
      const last = probe.lastDailyPackAt ? Date.parse(probe.lastDailyPackAt) : 0;
      const next = new Date(last + cooldownMs).toISOString();
      throw new DailyPackCooldownError(next);
    }
    const ownedCards: Record<string, number> = { ...(rows[0]!.owned_cards ?? {}) };
    for (const id of cardIds) ownedCards[id] = (ownedCards[id] ?? 0) + 1;
    const signature = `daily-pack:${userId}:${now}`;
    await this.pool.query(
      `UPDATE ${PROFILES_TABLE}
       SET owned_cards = $2::jsonb, packs_opened = packs_opened + 1, updated_at = $3
       WHERE user_id = $1`,
      [userId, JSON.stringify(ownedCards), now],
    );
    await this.pool.query(
      `INSERT INTO ${PACKS_TABLE} (user_id, signature, opened_at, card_ids)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (user_id, signature) DO NOTHING`,
      [userId, signature, now, JSON.stringify(cardIds)],
    );
    const profile = await this.findByUserId(userId);
    if (!profile) throw new Error(`Profile vanished after claim: ${userId}`);
    return {
      profile,
      purchase: { signature, openedAt: now, cardIds: [...cardIds] },
    };
  }

  async redeemBurnPack(
    userId: string,
    signature: string,
    cardIds: string[],
  ): Promise<{ profile: StoredProfile; purchase: PackPurchase; alreadyRedeemed: boolean }> {
    if (!signature) throw new Error('redeemBurnPack requires a non-empty signature');
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      throw new Error('redeemBurnPack requires at least one cardId');
    }
    // Idempotency check first: if this burn signature is already in
    // app_pack_purchases, return the existing purchase rather than
    // rolling a fresh pack.
    const existingPack = await this.pool.query<{ opened_at: string; card_ids: string[] }>(
      `SELECT opened_at, card_ids FROM ${PACKS_TABLE} WHERE user_id = $1 AND signature = $2`,
      [userId, signature],
    );
    if (existingPack.rows.length > 0) {
      const profile = await this.findByUserId(userId);
      if (!profile) throw new Error(`Profile vanished during redeem: ${userId}`);
      const row = existingPack.rows[0]!;
      return {
        profile,
        purchase: { signature, openedAt: row.opened_at, cardIds: row.card_ids },
        alreadyRedeemed: true,
      };
    }
    const now = nowIso();
    // Lock the profile row briefly while we read+merge ownedCards.
    const profileRow = await this.pool.query<{ owned_cards: Record<string, number> }>(
      `SELECT owned_cards FROM ${PROFILES_TABLE} WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (profileRow.rows.length === 0) {
      throw new Error(`Profile not found: ${userId}`);
    }
    const ownedCards: Record<string, number> = { ...(profileRow.rows[0]!.owned_cards ?? {}) };
    for (const id of cardIds) ownedCards[id] = (ownedCards[id] ?? 0) + 1;
    await this.pool.query(
      `UPDATE ${PROFILES_TABLE}
       SET owned_cards = $2::jsonb, packs_opened = packs_opened + 1, updated_at = $3
       WHERE user_id = $1`,
      [userId, JSON.stringify(ownedCards), now],
    );
    await this.pool.query(
      `INSERT INTO ${PACKS_TABLE} (user_id, signature, opened_at, card_ids)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (user_id, signature) DO NOTHING`,
      [userId, signature, now, JSON.stringify(cardIds)],
    );
    const profile = await this.findByUserId(userId);
    if (!profile) throw new Error(`Profile vanished after redeem: ${userId}`);
    return {
      profile,
      purchase: { signature, openedAt: now, cardIds: [...cardIds] },
      alreadyRedeemed: false,
    };
  }

  async listCampaignCompleteProfiles(): Promise<StoredProfile[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${PROFILES_TABLE}
       WHERE campaign_progress IS NOT NULL
         AND (campaign_progress->>'championDefeated')::boolean = TRUE
         AND jsonb_array_length(COALESCE(campaign_progress->'earnedBadges', '[]'::jsonb)) >= 8`,
    );
    return rows.map(storedProfileFromRow);
  }

  async ensureChampionsRowDraw(
    dateKey: string,
    resolve: () => Promise<{ winnerUserId: string | null; winnerWallet: string | null; cardIds: string[]; eligibleCount: number; seed: string }>,
  ): Promise<ChampionsRowDraw> {
    // Fast path: today's draw already exists.
    const existing = await this.pool.query(
      `SELECT * FROM ${CHAMPIONS_DRAWS_TABLE} WHERE date_key = $1`,
      [dateKey],
    );
    if (existing.rows.length > 0) return this.rowToDraw(existing.rows[0]);

    // Roll the draw. resolve() should produce a deterministic-ish but
    // unguessable winner pick. We then INSERT ON CONFLICT DO NOTHING so
    // a concurrent call doesn't overwrite us, and read back whatever
    // ended up landing.
    const rolled = await resolve();
    const drawnAt = nowIso();
    await this.pool.query(
      `INSERT INTO ${CHAMPIONS_DRAWS_TABLE}
         (date_key, winner_user_id, winner_wallet, card_ids, eligible_count, seed, drawn_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (date_key) DO NOTHING`,
      [dateKey, rolled.winnerUserId, rolled.winnerWallet, JSON.stringify(rolled.cardIds), rolled.eligibleCount, rolled.seed, drawnAt],
    );
    const reread = await this.pool.query(
      `SELECT * FROM ${CHAMPIONS_DRAWS_TABLE} WHERE date_key = $1`,
      [dateKey],
    );
    if (reread.rows.length === 0) {
      throw new Error(`Champions Row draw vanished for ${dateKey}`);
    }
    return this.rowToDraw(reread.rows[0]);
  }

  async claimChampionsRowDraw(
    userId: string,
    dateKey: string,
  ): Promise<{ profile: StoredProfile; purchase: PackPurchase; alreadyClaimed: boolean } | { notWinner: true }> {
    const draw = await this.pool.query(
      `SELECT * FROM ${CHAMPIONS_DRAWS_TABLE} WHERE date_key = $1`,
      [dateKey],
    );
    if (draw.rows.length === 0) {
      throw new Error(`No Champions Row draw for ${dateKey}`);
    }
    const row = this.rowToDraw(draw.rows[0]);
    if (row.winnerUserId !== userId) {
      return { notWinner: true };
    }
    const signature = `champions-row:${dateKey}`;
    const existingPack = await this.pool.query<{ opened_at: string; card_ids: string[] }>(
      `SELECT opened_at, card_ids FROM ${PACKS_TABLE} WHERE user_id = $1 AND signature = $2`,
      [userId, signature],
    );
    if (existingPack.rows.length > 0) {
      const profile = await this.findByUserId(userId);
      if (!profile) throw new Error(`Profile vanished: ${userId}`);
      const r = existingPack.rows[0]!;
      return {
        profile,
        purchase: { signature, openedAt: r.opened_at, cardIds: r.card_ids },
        alreadyClaimed: true,
      };
    }
    const now = nowIso();
    // Atomic owned-cards merge.
    const profileRow = await this.pool.query<{ owned_cards: Record<string, number> }>(
      `SELECT owned_cards FROM ${PROFILES_TABLE} WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (profileRow.rows.length === 0) throw new Error(`Profile not found: ${userId}`);
    const ownedCards: Record<string, number> = { ...(profileRow.rows[0]!.owned_cards ?? {}) };
    for (const id of row.cardIds) ownedCards[id] = (ownedCards[id] ?? 0) + 1;
    await this.pool.query(
      `UPDATE ${PROFILES_TABLE}
       SET owned_cards = $2::jsonb, packs_opened = packs_opened + 1, updated_at = $3
       WHERE user_id = $1`,
      [userId, JSON.stringify(ownedCards), now],
    );
    await this.pool.query(
      `INSERT INTO ${PACKS_TABLE} (user_id, signature, opened_at, card_ids)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (user_id, signature) DO NOTHING`,
      [userId, signature, now, JSON.stringify(row.cardIds)],
    );
    await this.pool.query(
      `UPDATE ${CHAMPIONS_DRAWS_TABLE} SET claimed_at = $2 WHERE date_key = $1`,
      [dateKey, now],
    );
    const profile = await this.findByUserId(userId);
    if (!profile) throw new Error(`Profile vanished: ${userId}`);
    return {
      profile,
      purchase: { signature, openedAt: now, cardIds: [...row.cardIds] },
      alreadyClaimed: false,
    };
  }

  private rowToDraw(row: {
    date_key: string;
    winner_user_id: string | null;
    winner_wallet: string | null;
    card_ids: string[];
    eligible_count: number;
    seed: string;
    drawn_at: string;
    claimed_at: string | null;
  }): ChampionsRowDraw {
    return {
      dateKey: row.date_key,
      winnerUserId: row.winner_user_id,
      winnerWallet: row.winner_wallet,
      cardIds: row.card_ids ?? [],
      eligibleCount: Number(row.eligible_count ?? 0),
      seed: row.seed,
      drawnAt: row.drawn_at,
      claimedAt: row.claimed_at ?? null,
    };
  }

  private async saveStoredProfile(profile: StoredProfile): Promise<StoredProfile> {
    const normalized = normalizeProfile(profile);
    await this.pool.query(
      `
        INSERT INTO ${PROFILES_TABLE}
          (user_id, login_key, name, wallet, active_deck_name, custom_deck, deck_library, imported_nfts, owned_cards, packs_opened, last_daily_pack_at, campaign_progress, created_at, updated_at, last_login_at)
        VALUES
          ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15)
        ON CONFLICT (user_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          wallet = EXCLUDED.wallet,
          active_deck_name = EXCLUDED.active_deck_name,
          custom_deck = EXCLUDED.custom_deck,
          deck_library = EXCLUDED.deck_library,
          imported_nfts = EXCLUDED.imported_nfts,
          owned_cards = EXCLUDED.owned_cards,
          packs_opened = EXCLUDED.packs_opened,
          campaign_progress = EXCLUDED.campaign_progress,
          updated_at = EXCLUDED.updated_at,
          last_login_at = EXCLUDED.last_login_at
      `,
      [
        profile.userId,
        profile.loginKey,
        normalized.name,
        normalized.wallet ? JSON.stringify(normalized.wallet) : null,
        normalized.activeDeckName,
        JSON.stringify(normalized.customDeck),
        JSON.stringify(normalized.deckLibrary),
        JSON.stringify(normalized.importedNfts ?? []),
        JSON.stringify(normalized.ownedCards),
        normalized.packsOpened,
        profile.lastDailyPackAt ?? null,
        normalized.campaignProgress ? JSON.stringify(normalized.campaignProgress) : null,
        profile.createdAt,
        profile.updatedAt,
        profile.lastLoginAt,
      ],
    );
    await this.syncPackPurchases(profile.userId, normalized.packPurchases);
    await this.syncMatchRecords(profile.userId, normalized.matchRecords);
    const saved = await this.findByUserId(profile.userId);
    if (!saved) {
      throw new Error(`Profile not saved: ${profile.userId}`);
    }
    return saved;
  }

  private async syncPackPurchases(userId: string, purchases: PackPurchase[]): Promise<void> {
    for (const purchase of purchases) {
      if (!purchase.signature) {
        continue;
      }
      await this.pool.query(
        `
          INSERT INTO ${PACKS_TABLE} (user_id, signature, opened_at, card_ids)
          VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT (user_id, signature)
          DO UPDATE SET opened_at = EXCLUDED.opened_at, card_ids = EXCLUDED.card_ids
        `,
        [userId, purchase.signature, purchase.openedAt, JSON.stringify(purchase.cardIds)],
      );
    }
  }

  private async syncMatchRecords(userId: string, records: MatchRecord[]): Promise<void> {
    for (const record of records) {
      if (this.isBeforeReset(record)) continue;
      await this.pool.query(
        `
          INSERT INTO ${MATCHES_TABLE}
            (user_id, match_id, player_id, player_deck_label, opponent_deck_label, result, winner, reason, started_at, completed_at, match_type, wager_amount, wager_currency, winner_wallet)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (user_id, match_id, player_id)
          DO UPDATE SET
            player_deck_label = EXCLUDED.player_deck_label,
            opponent_deck_label = EXCLUDED.opponent_deck_label,
            result = EXCLUDED.result,
            winner = EXCLUDED.winner,
            reason = EXCLUDED.reason,
            completed_at = EXCLUDED.completed_at,
            match_type = EXCLUDED.match_type,
            wager_amount = EXCLUDED.wager_amount,
            wager_currency = EXCLUDED.wager_currency,
            winner_wallet = EXCLUDED.winner_wallet
        `,
        [
          userId,
          record.matchID,
          record.playerID,
          record.playerDeckLabel,
          record.opponentDeckLabel,
          record.result,
          record.winner,
          record.reason,
          record.startedAt,
          record.completedAt,
          record.matchType ?? 'Ranked',
          record.wagerAmount ?? null,
          record.wagerCurrency ?? null,
          record.winnerWallet ?? null,
        ],
      );
    }
  }
}

export class MemoryProfileStorage implements ProfileStorage {
  private readonly profiles = new Map<string, StoredProfile>();
  private readonly loginKeys = new Map<string, string>();
  private readonly dailyRewards = new Map<string, DailyLeaderboardReward[]>();

  async connect(): Promise<void> {
    return;
  }

  async findProfileByUserId(userId: string): Promise<StoredProfile | undefined> {
    return this.profiles.get(userId);
  }

  async login(profile: ProfileState): Promise<StoredProfile> {
    const loginKey = loginKeyForProfile(profile);
    const existingId = this.loginKeys.get(loginKey);
    const existing = existingId ? this.profiles.get(existingId) : undefined;
    if (existing) {
      return this.saveStoredProfile(mergeProfiles(existing, profile));
    }

    const timestamp = nowIso();
    return this.saveStoredProfile({
      ...normalizeProfile(profile),
      userId: randomUUID(),
      loginKey,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: timestamp,
    });
  }

  async saveProfile(userId: string, profile: ProfileState): Promise<StoredProfile> {
    const existing = this.profiles.get(userId);
    if (!existing) {
      throw new Error(`Profile not found: ${userId}`);
    }
    return this.saveStoredProfile({
      ...existing,
      ...normalizeProfile(profile),
      userId,
      loginKey: existing.loginKey,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
  }

  async recordPack(userId: string, _purchase: PackPurchase, profile: ProfileState): Promise<StoredProfile> {
    return this.saveProfile(userId, profile);
  }

  async recordMatch(userId: string, record: MatchRecord): Promise<StoredProfile> {
    const existing = this.profiles.get(userId);
    if (!existing) {
      throw new Error(`Profile not found: ${userId}`);
    }
    const records = new Map(existing.matchRecords.map((candidate) => [`${candidate.matchID}:${candidate.playerID}`, candidate]));
    records.set(`${record.matchID}:${record.playerID}`, record);
    return this.saveStoredProfile({ ...existing, matchRecords: [...records.values()], updatedAt: nowIso() });
  }

  async listLeaderboard(): Promise<MatchLeaderboardEntry[]> {
    return [...this.profiles.values()]
      .map((profile) => {
        // Every completed match counts toward the W/L record, regardless
        // of matchType. Mirrors the Postgres listLeaderboard() query above.
        const completed = profile.matchRecords.filter(
          (record) => record.result !== 'in_progress',
        );
        return {
          userId: profile.userId,
          name: profile.name,
          matches: completed.length,
          wins: completed.filter((record) => record.result === 'win').length,
          losses: completed.filter((record) => record.result === 'loss').length,
          draws: completed.filter((record) => record.result === 'draw').length,
        };
      })
      .filter((entry) => entry.matches > 0)
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.draws - a.draws || b.matches - a.matches || a.name.localeCompare(b.name))
      .slice(0, 50);
  }

  async listDailyLeaderboard(dateKey: string): Promise<MatchLeaderboardEntry[]> {
    const startMs = Date.parse(`${dateKey}T00:00:00.000Z`);
    if (Number.isNaN(startMs)) return [];
    const endMs = startMs + 24 * 60 * 60 * 1000;
    return [...this.profiles.values()]
      .map((profile) => {
        const completed = profile.matchRecords.filter((record) => {
          if (record.result === 'in_progress') return false;
          const startedMs = Date.parse(record.startedAt ?? '');
          return Number.isFinite(startedMs) && startedMs >= startMs && startedMs < endMs;
        });
        return {
          userId: profile.userId,
          name: profile.name,
          matches: completed.length,
          wins: completed.filter((record) => record.result === 'win').length,
          losses: completed.filter((record) => record.result === 'loss').length,
          draws: completed.filter((record) => record.result === 'draw').length,
        };
      })
      .filter((entry) => entry.matches > 0)
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.draws - a.draws || b.matches - a.matches || a.name.localeCompare(b.name))
      .slice(0, 50);
  }

  async settleDailyLeaderboard(dateKey: string): Promise<DailyLeaderboardReward[]> {
    const cached = this.dailyRewards.get(dateKey);
    if (cached) return cached;
    const top = await this.listDailyLeaderboard(dateKey);
    const winners = top.slice(0, 3);
    if (winners.length === 0) {
      this.dailyRewards.set(dateKey, []);
      return [];
    }
    const settledAt = nowIso();
    const rewards = winners.map((entry, idx) => ({
      dateKey,
      rank: idx + 1,
      userId: entry.userId,
      name: entry.name,
      wins: entry.wins,
      losses: entry.losses,
      draws: entry.draws,
      matches: entry.matches,
      cardIds: null,
      claimedAt: null,
    } satisfies DailyLeaderboardReward));
    this.dailyRewards.set(dateKey, rewards);
    return rewards.map((r) => ({ ...r }));
  }

  async listUnclaimedDailyRewards(userId: string): Promise<DailyLeaderboardReward[]> {
    const out: DailyLeaderboardReward[] = [];
    for (const rewards of this.dailyRewards.values()) {
      for (const reward of rewards) {
        if (reward.userId === userId && reward.claimedAt === null) out.push({ ...reward });
      }
    }
    return out.sort((a, b) => b.dateKey.localeCompare(a.dateKey) || a.rank - b.rank);
  }

  async claimDailyLeaderboardReward(
    userId: string,
    dateKey: string,
    rank: number,
    cardIds: string[],
  ): Promise<{ profile: StoredProfile; purchase: PackPurchase; alreadyClaimed: boolean }> {
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      throw new Error('claimDailyLeaderboardReward requires cardIds');
    }
    const list = this.dailyRewards.get(dateKey);
    if (!list) throw new Error('No reward row for that (dateKey, rank)');
    const reward = list.find((r) => r.rank === rank);
    if (!reward) throw new Error('No reward row for that (dateKey, rank)');
    if (reward.userId !== userId) throw new Error("That reward isn't yours.");
    const profile = this.profiles.get(userId);
    if (!profile) throw new Error(`Profile not found: ${userId}`);
    const signature = `daily-leaderboard:${dateKey}:rank-${rank}`;
    if (reward.claimedAt && reward.cardIds) {
      // Replay: hand back the same purchase shape.
      return {
        profile,
        purchase: { signature, openedAt: reward.claimedAt, cardIds: [...reward.cardIds] },
        alreadyClaimed: true,
      };
    }
    const ownedCards = { ...profile.ownedCards };
    for (const id of cardIds) ownedCards[id] = (ownedCards[id] ?? 0) + 1;
    const now = nowIso();
    const updated = await this.saveStoredProfile({
      ...profile,
      ownedCards,
      packsOpened: profile.packsOpened + 1,
      packPurchases: [...profile.packPurchases, { signature, openedAt: now, cardIds: [...cardIds] }],
      updatedAt: now,
    });
    reward.claimedAt = now;
    reward.cardIds = [...cardIds];
    return { profile: updated, purchase: { signature, openedAt: now, cardIds: [...cardIds] }, alreadyClaimed: false };
  }

  async claimDailyPack(
    userId: string,
    cardIds: string[],
    cooldownMs: number,
  ): Promise<{ profile: StoredProfile; purchase: PackPurchase }> {
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      throw new Error('claimDailyPack requires at least one cardId');
    }
    const existing = this.profiles.get(userId);
    if (!existing) throw new Error(`Profile not found: ${userId}`);
    const last = existing.lastDailyPackAt ? Date.parse(existing.lastDailyPackAt) : 0;
    if (Date.now() - last < cooldownMs) {
      const next = new Date(last + cooldownMs).toISOString();
      throw new DailyPackCooldownError(next);
    }
    const now = nowIso();
    const ownedCards: Record<string, number> = { ...existing.ownedCards };
    for (const id of cardIds) ownedCards[id] = (ownedCards[id] ?? 0) + 1;
    const signature = `daily-pack:${userId}:${now}`;
    const purchase: PackPurchase = { signature, openedAt: now, cardIds: [...cardIds] };
    const updated: StoredProfile = {
      ...existing,
      ownedCards,
      packsOpened: existing.packsOpened + 1,
      packPurchases: [...existing.packPurchases, purchase],
      lastDailyPackAt: now,
      updatedAt: now,
    };
    this.profiles.set(userId, updated);
    return { profile: updated, purchase };
  }

  async redeemBurnPack(
    userId: string,
    signature: string,
    cardIds: string[],
  ): Promise<{ profile: StoredProfile; purchase: PackPurchase; alreadyRedeemed: boolean }> {
    if (!signature) throw new Error('redeemBurnPack requires a non-empty signature');
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      throw new Error('redeemBurnPack requires at least one cardId');
    }
    const existing = this.profiles.get(userId);
    if (!existing) throw new Error(`Profile not found: ${userId}`);
    const replay = existing.packPurchases.find((p) => p.signature === signature);
    if (replay) {
      return { profile: existing, purchase: replay, alreadyRedeemed: true };
    }
    const now = nowIso();
    const ownedCards: Record<string, number> = { ...existing.ownedCards };
    for (const id of cardIds) ownedCards[id] = (ownedCards[id] ?? 0) + 1;
    const purchase: PackPurchase = { signature, openedAt: now, cardIds: [...cardIds] };
    const updated: StoredProfile = {
      ...existing,
      ownedCards,
      packsOpened: existing.packsOpened + 1,
      packPurchases: [...existing.packPurchases, purchase],
      updatedAt: now,
    };
    this.profiles.set(userId, updated);
    return { profile: updated, purchase, alreadyRedeemed: false };
  }

  // Champions Row in-memory implementations.
  private readonly championsRowDraws = new Map<string, ChampionsRowDraw>();

  async listCampaignCompleteProfiles(): Promise<StoredProfile[]> {
    const out: StoredProfile[] = [];
    for (const profile of this.profiles.values()) {
      const cp = profile.campaignProgress;
      if (!cp || !cp.championDefeated) continue;
      if (!Array.isArray(cp.earnedBadges) || cp.earnedBadges.length < 8) continue;
      out.push(profile);
    }
    return out;
  }

  async ensureChampionsRowDraw(
    dateKey: string,
    resolve: () => Promise<{ winnerUserId: string | null; winnerWallet: string | null; cardIds: string[]; eligibleCount: number; seed: string }>,
  ): Promise<ChampionsRowDraw> {
    const existing = this.championsRowDraws.get(dateKey);
    if (existing) return existing;
    const rolled = await resolve();
    const draw: ChampionsRowDraw = {
      dateKey,
      winnerUserId: rolled.winnerUserId,
      winnerWallet: rolled.winnerWallet,
      cardIds: [...rolled.cardIds],
      eligibleCount: rolled.eligibleCount,
      seed: rolled.seed,
      drawnAt: nowIso(),
      claimedAt: null,
    };
    this.championsRowDraws.set(dateKey, draw);
    return draw;
  }

  async claimChampionsRowDraw(
    userId: string,
    dateKey: string,
  ): Promise<{ profile: StoredProfile; purchase: PackPurchase; alreadyClaimed: boolean } | { notWinner: true }> {
    const draw = this.championsRowDraws.get(dateKey);
    if (!draw) throw new Error(`No Champions Row draw for ${dateKey}`);
    if (draw.winnerUserId !== userId) return { notWinner: true };
    const existing = this.profiles.get(userId);
    if (!existing) throw new Error(`Profile not found: ${userId}`);
    const signature = `champions-row:${dateKey}`;
    const replay = existing.packPurchases.find((p) => p.signature === signature);
    if (replay) {
      return { profile: existing, purchase: replay, alreadyClaimed: true };
    }
    const now = nowIso();
    const ownedCards: Record<string, number> = { ...existing.ownedCards };
    for (const id of draw.cardIds) ownedCards[id] = (ownedCards[id] ?? 0) + 1;
    const purchase: PackPurchase = { signature, openedAt: now, cardIds: [...draw.cardIds] };
    const updated: StoredProfile = {
      ...existing,
      ownedCards,
      packsOpened: existing.packsOpened + 1,
      packPurchases: [...existing.packPurchases, purchase],
      updatedAt: now,
    };
    this.profiles.set(userId, updated);
    this.championsRowDraws.set(dateKey, { ...draw, claimedAt: now });
    return { profile: updated, purchase, alreadyClaimed: false };
  }

  private saveStoredProfile(profile: StoredProfile): StoredProfile {
    this.profiles.set(profile.userId, profile);
    this.loginKeys.set(profile.loginKey, profile.userId);
    return profile;
  }
}
