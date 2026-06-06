import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import type { MatchRecord, PackPurchase, ProfileState, StoredProfile } from '../shared/profile';
import { loginKeyForProfile, maxCollections } from '../shared/profile';

interface ProfileStorage {
  connect(): Promise<void>;
  login(profile: ProfileState): Promise<StoredProfile>;
  saveProfile(userId: string, profile: ProfileState): Promise<StoredProfile>;
  recordPack(userId: string, purchase: PackPurchase, profile: ProfileState): Promise<StoredProfile>;
  recordMatch(userId: string, record: MatchRecord): Promise<StoredProfile>;
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
    ownedCards: profile.ownedCards ?? {},
    packsOpened: Number.isFinite(profile.packsOpened) ? profile.packsOpened : 0,
    packPurchases: Array.isArray(profile.packPurchases) ? profile.packPurchases : [],
    matchRecords: Array.isArray(profile.matchRecords) ? profile.matchRecords : [],
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

  return {
    ...existing,
    name: normalized.name,
    wallet: normalized.wallet,
    activeDeckName: normalized.activeDeckName || existing.activeDeckName,
    customDeck: normalized.customDeck.length > 0 ? normalized.customDeck : existing.customDeck,
    ownedCards: maxCollections(existing.ownedCards, normalized.ownedCards),
    packsOpened: Math.max(existing.packsOpened, normalized.packsOpened, purchases.size),
    packPurchases: [...purchases.values()],
    matchRecords: [...matches.values()],
    updatedAt: nowIso(),
    lastLoginAt: nowIso(),
  };
}

function storedProfileFromRow(row: {
  active_deck_name: string;
  created_at: string;
  custom_deck: string[];
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
    ownedCards: row.owned_cards,
    packsOpened: row.packs_opened,
    packPurchases: row.pack_purchases ?? [],
    matchRecords: row.match_records ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export class PostgresProfileStorage implements ProfileStorage {
  private readonly pool: Pool;

  constructor(connectionString: string, ssl?: PoolConfig['ssl']) {
    this.pool = new Pool({ connectionString, ssl });
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
        owned_cards JSONB NOT NULL,
        packs_opened INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_login_at TIMESTAMPTZ NOT NULL
      )
    `);
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
    await this.pool.query(
      `
        INSERT INTO ${MATCHES_TABLE}
          (user_id, match_id, player_id, player_deck_label, opponent_deck_label, result, winner, reason, started_at, completed_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (user_id, match_id, player_id)
        DO UPDATE SET
          player_deck_label = EXCLUDED.player_deck_label,
          opponent_deck_label = EXCLUDED.opponent_deck_label,
          result = EXCLUDED.result,
          winner = EXCLUDED.winner,
          reason = EXCLUDED.reason,
          completed_at = EXCLUDED.completed_at
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

  private async findByLoginKey(loginKey: string): Promise<StoredProfile | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM ${PROFILES_TABLE} WHERE login_key = $1`, [loginKey]);
    return rows[0] ? storedProfileFromRow(rows[0]) : undefined;
  }

  private async findByUserId(userId: string): Promise<StoredProfile | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM ${PROFILES_TABLE} WHERE user_id = $1`, [userId]);
    return rows[0] ? storedProfileFromRow(rows[0]) : undefined;
  }

  private async saveStoredProfile(profile: StoredProfile): Promise<StoredProfile> {
    const normalized = normalizeProfile(profile);
    await this.pool.query(
      `
        INSERT INTO ${PROFILES_TABLE}
          (user_id, login_key, name, wallet, active_deck_name, custom_deck, owned_cards, packs_opened, created_at, updated_at, last_login_at)
        VALUES
          ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
        ON CONFLICT (user_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          wallet = EXCLUDED.wallet,
          active_deck_name = EXCLUDED.active_deck_name,
          custom_deck = EXCLUDED.custom_deck,
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
      await this.pool.query(
        `
          INSERT INTO ${MATCHES_TABLE}
            (user_id, match_id, player_id, player_deck_label, opponent_deck_label, result, winner, reason, started_at, completed_at)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (user_id, match_id, player_id)
          DO UPDATE SET
            player_deck_label = EXCLUDED.player_deck_label,
            opponent_deck_label = EXCLUDED.opponent_deck_label,
            result = EXCLUDED.result,
            winner = EXCLUDED.winner,
            reason = EXCLUDED.reason,
            completed_at = EXCLUDED.completed_at
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

  private saveStoredProfile(profile: StoredProfile): StoredProfile {
    this.profiles.set(profile.userId, profile);
    this.loginKeys.set(profile.loginKey, profile.userId);
    return profile;
  }
}

export type { ProfileStorage };
