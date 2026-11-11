import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface DurableIdentity {
  eventId: string;
  imei: string;
  hash: string;
}

export function reconcile(
  confirmed: [string, number][],
  records: DurableIdentity[],
  duplicates: [string, number][] = [],
) {
  const identities = new Map<string, string>();
  let conflicts = 0;

  for (const record of records) {
    const key = `${record.imei}:${record.hash}`;
    const previous = identities.get(record.eventId);

    if (previous && previous !== key) {
      conflicts++;
    }

    identities.set(record.eventId, key);
  }

  const counts = new Map<string, number>();

  for (const key of identities.values()) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const deduplicated = new Map(duplicates);
  let missing = 0;

  for (const [key, count] of confirmed) {
    missing += Math.max(0, count - (deduplicated.get(key) ?? 0) - (counts.get(key) ?? 0));
  }

  return {
    uniqueDurableEvents: identities.size,
    confirmedAdmissions: confirmed.reduce((sum, entry) => sum + entry[1], 0),
    expectedDuplicateAdmissions: duplicates.reduce((sum, entry) => sum + entry[1], 0),
    confirmedMissing: missing,
    conflictingEventIds: conflicts,
  };
}

export async function auditDurability(directory: string, database: DurableIdentity[]) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as {
    confirmed: [string, number][];
    duplicates?: [string, number][];
  };
  const records = [...database];
  let pending = 0;
  let quarantined = 0;
  let unreadable = 0;

  for (const folder of ['', 'quarantine']) {
    const path = resolve(directory, 'spool-snapshot', folder);

    for (const file of await readdir(path)) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const event = JSON.parse(await readFile(resolve(path, file), 'utf8')) as {
          eventId: string;
          deviceIdentifier: string;
          source: { rawSha256: string };
        };

        if (!event.eventId || !event.deviceIdentifier || !event.source?.rawSha256) {
          throw new Error('Missing packet identity');
        }

        records.push({
          eventId: event.eventId,
          imei: event.deviceIdentifier,
          hash: event.source.rawSha256,
        });
        if (folder) {
          quarantined++;
        } else {
          pending++;
        }
      } catch {
        unreadable++;
      }
    }
  }

  const report = {
    ...reconcile(manifest.confirmed, records, manifest.duplicates),
    databaseEvents: database.length,
    pendingSpoolEvents: pending,
    quarantinedEvents: quarantined,
    unreadableFiles: unreadable,
    overlapEvents:
      database.length + pending + quarantined - new Set(records.map((entry) => entry.eventId)).size,
  };

  await writeFile(resolve(directory, 'durability.json'), JSON.stringify(report, null, 2));

  return report;
}

export async function dumpTestDatabase() {
  assert.equal(
    process.env.FLEET_LOAD_TEST,
    'isolated',
    'Database audit is only for the disposable load test',
  );
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });

  try {
    const result = await pool.query(
      "SELECT l.event_id,d.imei,l.normalized_data #>> '{source,rawSha256}' AS hash FROM device_logs l JOIN devices d ON d.id=l.device_id",
    );

    console.log(
      JSON.stringify(
        result.rows.map((row) => ({ eventId: row.event_id, imei: row.imei, hash: row.hash })),
      ),
    );
  } finally {
    await pool.end();
  }
}
