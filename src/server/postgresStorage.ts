import { createRequire } from 'node:module';
import { Pool, type PoolConfig } from 'pg';
import type { LogEntry, Server as BGIOServer, State, StorageAPI } from 'boardgame.io';

const require = createRequire(import.meta.url);
const { Async } = require('boardgame.io/internal') as typeof import('boardgame.io/internal');

interface PostgresStorageOptions {
  connectionString: string;
  ssl?: PoolConfig['ssl'];
}

const TABLE_NAME = 'bgio_matches';

export class PostgresStorage extends Async {
  private readonly pool: Pool;

  constructor({ connectionString, ssl }: PostgresStorageOptions) {
    super();
    this.pool = new Pool({ connectionString, ssl });
  }

  async connect(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        match_id TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        initial_state JSONB NOT NULL,
        metadata JSONB NOT NULL,
        log JSONB NOT NULL DEFAULT '[]'::jsonb,
        game_name TEXT NOT NULL,
        is_gameover BOOLEAN NOT NULL DEFAULT FALSE,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE_NAME}_game_name_idx ON ${TABLE_NAME} (game_name)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE_NAME}_gameover_idx ON ${TABLE_NAME} (is_gameover)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE_NAME}_updated_at_idx ON ${TABLE_NAME} (updated_at)`);
  }

  async createMatch(matchID: string, opts: StorageAPI.CreateMatchOpts): Promise<void> {
    const metadata = opts.metadata;
    await this.pool.query(
      `
        INSERT INTO ${TABLE_NAME}
          (match_id, state, initial_state, metadata, log, game_name, is_gameover, created_at, updated_at)
        VALUES
          ($1, $2::jsonb, $3::jsonb, $4::jsonb, '[]'::jsonb, $5, $6, $7, $8)
      `,
      [
        matchID,
        JSON.stringify(opts.initialState),
        JSON.stringify(opts.initialState),
        JSON.stringify(metadata),
        metadata.gameName,
        metadata.gameover !== undefined,
        metadata.createdAt,
        metadata.updatedAt,
      ],
    );
  }

  async setState(matchID: string, state: State, deltalog?: LogEntry[]): Promise<void> {
    await this.pool.query(
      `
        UPDATE ${TABLE_NAME}
        SET
          state = $2::jsonb,
          log = CASE
            WHEN $3::jsonb = '[]'::jsonb THEN log
            ELSE log || $3::jsonb
          END
        WHERE match_id = $1
      `,
      [matchID, JSON.stringify(state), JSON.stringify(deltalog ?? [])],
    );
  }

  async setMetadata(matchID: string, metadata: BGIOServer.MatchData): Promise<void> {
    await this.pool.query(
      `
        UPDATE ${TABLE_NAME}
        SET
          metadata = $2::jsonb,
          game_name = $3,
          is_gameover = $4,
          created_at = $5,
          updated_at = $6
        WHERE match_id = $1
      `,
      [
        matchID,
        JSON.stringify(metadata),
        metadata.gameName,
        metadata.gameover !== undefined,
        metadata.createdAt,
        metadata.updatedAt,
      ],
    );
  }

  async fetch<O extends StorageAPI.FetchOpts>(
    matchID: string,
    opts: O,
  ): Promise<StorageAPI.FetchResult<O>> {
    const { rows } = await this.pool.query<{
      state: State;
      initial_state: State;
      metadata: BGIOServer.MatchData;
      log: LogEntry[] | null;
    }>(
      `
        SELECT state, initial_state, metadata, log
        FROM ${TABLE_NAME}
        WHERE match_id = $1
      `,
      [matchID],
    );
    const row = rows[0];
    const result = {} as StorageAPI.FetchFields;

    if (!row) {
      return result as StorageAPI.FetchResult<O>;
    }

    if (opts.state) {
      result.state = row.state;
    }
    if (opts.initialState) {
      result.initialState = row.initial_state;
    }
    if (opts.metadata) {
      result.metadata = row.metadata;
    }
    if (opts.log) {
      result.log = row.log ?? [];
    }

    return result as StorageAPI.FetchResult<O>;
  }

  async wipe(matchID: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${TABLE_NAME} WHERE match_id = $1`, [matchID]);
  }

  async listMatches(opts?: StorageAPI.ListMatchesOpts): Promise<string[]> {
    const where: string[] = [];
    const values: Array<string | number | boolean> = [];

    if (opts?.gameName !== undefined) {
      values.push(opts.gameName);
      where.push(`game_name = $${values.length}`);
    }
    if (opts?.where?.isGameover !== undefined) {
      values.push(opts.where.isGameover);
      where.push(`is_gameover = $${values.length}`);
    }
    if (opts?.where?.updatedBefore !== undefined) {
      values.push(opts.where.updatedBefore);
      where.push(`updated_at < $${values.length}`);
    }
    if (opts?.where?.updatedAfter !== undefined) {
      values.push(opts.where.updatedAfter);
      where.push(`updated_at > $${values.length}`);
    }

    const { rows } = await this.pool.query<{ match_id: string }>(
      `
        SELECT match_id
        FROM ${TABLE_NAME}
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY updated_at DESC
      `,
      values,
    );

    return rows.map((row) => row.match_id);
  }
}

export function postgresSslFromEnv(): PoolConfig['ssl'] {
  const sslMode = process.env.PGSSLMODE ?? process.env.DATABASE_SSL;
  if (!sslMode || sslMode === 'disable' || sslMode === 'false') {
    return undefined;
  }
  return { rejectUnauthorized: sslMode !== 'no-verify' };
}
