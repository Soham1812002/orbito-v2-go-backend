import type { SqlExecutor } from '../../database/executor.js';
import type { FleetTransaction } from '../fleet/fleet.ports.js';

export function auditRepository(db: SqlExecutor, newId: () => string): FleetTransaction['audit'] {
  return {
    async record(org, actor, action, target, changes) {
      await db.query(
        `
      INSERT INTO
        audit_logs (
          id,
          organization_id,
          actor_id,
          action,
          target_id,
          changes
        )
      VALUES
        ($1, $2, $3, $4, $5, $6)
    `,
        [newId(), org, actor, action, target, JSON.stringify(changes)],
      );
    },
  };
}
