import type pg from 'pg';

export type SqlExecutor = Pick<pg.PoolClient, 'query'>;
