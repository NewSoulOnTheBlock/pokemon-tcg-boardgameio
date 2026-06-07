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
  findProfileByWallet?(walletAddress: string): Promise<StoredProfile | undefined>;
  reservePrizeClaim?(userId: string, matchID: string, playerID: string): Promise<{
    eligible: boolean;
    reason?: string;
    alreadyClaimed?: { cardId: string; mintAddress?: string; signature?: string };
  }>;
  recordPrizeClaim?(userId: string, matchID: string, playerID: string, prize: { cardId: string; mintAddress?: string; signature?: string }): Promise<void>;
}

const PROFILES_TABLE = 'app_profiles';
const PACKS_TABLE = 'app_pack_purchases';
const MATCHES_TABLE = 'app_match_records';

function nowIso(): string {
  return new Date().toISOString();
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
    // Casual matches are explicitly excluded so they show up in personal
    // history but don't affect the public ranking. Ranked + Wager both count.
    // INNER JOIN + HAVING keeps profiles with zero ranked games out of the
    // leaderboard so it doesn't show every signed-up user at 0/0/0/0.
    const { rows } = await this.pool.query<MatchLeaderboardEntry>(`
      SELECT
        p.user_id AS "userId",
        p.name,
        COUNT(*) FILTER (WHERE m.result IN ('win', 'loss', 'draw') AND m.match_type IN ('Ranked', 'Wager'))::int AS matches,
        COUNT(*) FILTER (WHERE m.result = 'win' AND m.match_type IN ('Ranked', 'Wager'))::int AS wins,
        COUNT(*) FILTER (WHERE m.result = 'loss' AND m.match_type IN ('Ranked', 'Wager'))::int AS losses,
        COUNT(*) FILTER (WHERE m.result = 'draw' AND m.match_type IN ('Ranked', 'Wager'))::int AS draws
      FROM ${PROFILES_TABLE} p
      INNER JOIN ${MATCHES_TABLE} m ON m.user_id = p.user_id
      GROUP BY p.user_id, p.name
      HAVING COUNT(*) FILTER (WHERE m.result IN ('win', 'loss', 'draw') AND m.match_type IN ('Ranked', 'Wager')) > 0
      ORDER BY wins DESC, losses ASC, draws DESC, matches DESC, p.name ASC
      LIMIT 50
    `);
    return rows;
  }

  private async findByLoginKey(loginKey: string): Promise<StoredProfile | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM ${PROFILES_TABLE} WHERE login_key = $1`, [loginKey]);
    return rows[0] ? storedProfileFromRow(rows[0]) : undefined;
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

  private async saveStoredProfile(profile: StoredProfile): Promise<StoredProfile> {
    const normalized = normalizeProfile(profile);
    await this.pool.query(
      `
        INSERT INTO ${PROFILES_TABLE}
          (user_id, login_key, name, wallet, active_deck_name, custom_deck, deck_library, imported_nfts, owned_cards, packs_opened, created_at, updated_at, last_login_at)
        VALUES
          ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
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

  async connect(): Promise<void> {
    return;
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
        // Casual matches are tracked in the user's personal history but
        // explicitly excluded from the leaderboard, mirroring the Postgres
        // listLeaderboard() query above.
        const ranked = profile.matchRecords.filter(
          (record) => record.result !== 'in_progress' && (record.matchType ?? 'Ranked') !== 'Casual',
        );
        return {
          userId: profile.userId,
          name: profile.name,
          matches: ranked.length,
          wins: ranked.filter((record) => record.result === 'win').length,
          losses: ranked.filter((record) => record.result === 'loss').length,
          draws: ranked.filter((record) => record.result === 'draw').length,
        };
      })
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.draws - a.draws || b.matches - a.matches || a.name.localeCompare(b.name))
      .slice(0, 50);
  }

  private saveStoredProfile(profile: StoredProfile): StoredProfile {
    this.profiles.set(profile.userId, profile);
    this.loginKeys.set(profile.loginKey, profile.userId);
    return profile;
  }
}
