// Postgres-backed card catalogue. The schema is intentionally simple — we
// store the full Card JSON in a JSONB column plus the few scalar fields the
// engine queries on. The DB acts as the source of truth: server boots load
// CARD_LIBRARY from here; the only consumer of the bundled manifest is the
// one-time migration that runs when the table is empty.

import { Pool, type PoolConfig } from 'pg';
import type { Card } from '../game/types';

export interface CardStorage {
  connect(): Promise<void>;
  hasCards(): Promise<boolean>;
  bulkUpsert(cards: Card[]): Promise<void>;
  listCards(): Promise<Card[]>;
}

const TABLE = 'app_cards';

export class PostgresCardStorage implements CardStorage {
  private readonly pool: Pool;

  constructor(connectionString: string, ssl?: PoolConfig['ssl']) {
    this.pool = new Pool({ connectionString, ssl });
  }

  async connect(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        rarity TEXT,
        source_id TEXT,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_kind_idx ON ${TABLE} (kind)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_rarity_idx ON ${TABLE} (rarity)`);
  }

  async hasCards(): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT 1 FROM ${TABLE} LIMIT 1`);
    return rows.length > 0;
  }

  async bulkUpsert(cards: Card[]): Promise<void> {
    // 500-row batches keep the SQL statement under Postgres' 65k-parameter
    // limit (6 params per row → 3000 placeholders per statement).
    const BATCH = 500;
    for (let i = 0; i < cards.length; i += BATCH) {
      const batch = cards.slice(i, i + BATCH);
      const values: Array<string | null> = [];
      const placeholders = batch.map((card, idx) => {
        const base = idx * 6;
        values.push(
          card.id,
          card.kind,
          card.name,
          card.rarity ?? null,
          card.sourceId ?? null,
          JSON.stringify(card),
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb)`;
      }).join(',');
      await this.pool.query(
        `INSERT INTO ${TABLE} (id, kind, name, rarity, source_id, data)
         VALUES ${placeholders}
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind,
           name = EXCLUDED.name,
           rarity = EXCLUDED.rarity,
           source_id = EXCLUDED.source_id,
           data = EXCLUDED.data,
           updated_at = NOW()`,
        values,
      );
    }
  }

  async listCards(): Promise<Card[]> {
    const { rows } = await this.pool.query<{ data: Card }>(`SELECT data FROM ${TABLE}`);
    return rows.map((row) => row.data);
  }
}

/** In-memory fallback for `DATABASE_URL`-less local dev. */
export class MemoryCardStorage implements CardStorage {
  private cards: Card[] = [];

  async connect(): Promise<void> {
    return;
  }

  async hasCards(): Promise<boolean> {
    return this.cards.length > 0;
  }

  async bulkUpsert(cards: Card[]): Promise<void> {
    const byId = new Map(this.cards.map((card) => [card.id, card]));
    for (const card of cards) byId.set(card.id, card);
    this.cards = [...byId.values()];
  }

  async listCards(): Promise<Card[]> {
    return [...this.cards];
  }
}
