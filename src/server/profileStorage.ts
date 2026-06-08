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
}

const PROFILES_TABLE = 'app_profiles';
const PACKS_TABLE = 'app_pack_purchases';
const MATCHES_TABLE = 'app_match_records';

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

  private async saveStoredProfile(profile: StoredProfile): Promise<StoredProfile> {
    const normalized = normalizeProfile(profile);
    await this.pool.query(
      `
        INSERT INTO ${PROFILES_TABLE}
          (user_id, login_key, name, wallet, active_deck_name, custom_deck, deck_library, imported_nfts, owned_cards, packs_opened, last_daily_pack_at, created_at, updated_at, last_login_at)
        VALUES
          ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
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
        profile.lastDailyPackAt ?? null,
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

  private saveStoredProfile(profile: StoredProfile): StoredProfile {
    this.profiles.set(profile.userId, profile);
    this.loginKeys.set(profile.loginKey, profile.userId);
    return profile;
  }
}
