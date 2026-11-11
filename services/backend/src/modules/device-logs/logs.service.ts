import type { Actor } from '../../application/actor.js';
import type { LogQuery } from '../../../../../shared/contracts/logs.js';
import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import type { LogReader } from './logs.ports.js';
import { decodeCursor, encodeCursor } from './logs.cursor.js';

export function createLogService(read: LogReader, now: () => number) {
  return {
    async list(actor: Actor, q: LogQuery) {
      const to = q.to ?? new Date(now()).toISOString();
      const from = q.from ?? new Date(Date.parse(to) - 86400000).toISOString();

      if (Date.parse(to) - Date.parse(from) > 7 * 86400000 || Date.parse(to) < Date.parse(from)) {
        throw new ApplicationError('invalid_input', 'Select a range of at most seven days');
      }

      const rows = await read.list(
        actor.organization_id,
        q,
        from,
        to,
        q.cursor ? decodeCursor(q.cursor) : undefined,
      );
      const items = rows.slice(0, q.limit);
      const last = items.at(-1);

      return {
        items: items.map(({ received_at_exact, ...row }) => ({
          ...row,
          received_at: received_at_exact ?? row.received_at.toISOString(),
          device_time: row.device_time?.toISOString() ?? null,
        })),
        nextCursor:
          rows.length > q.limit && last
            ? encodeCursor(last.received_at_exact ?? last.received_at, last.id)
            : null,
        from,
        to,
      };
    },
    async detail(actor: Actor, id: string) {
      const record = await read.detail(actor.organization_id, id);

      if (!record) {
        throw new ApplicationError('not_found', 'Log not found');
      }

      if (actor.role === 'admin') {
        return record;
      }

      const result = { ...record };

      delete result.raw_data;

      return result;
    },
  };
}

export type LogService = ReturnType<typeof createLogService>;
