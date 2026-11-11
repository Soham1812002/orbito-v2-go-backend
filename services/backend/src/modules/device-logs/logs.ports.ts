import type { DeviceLog } from '../../../../../shared/contracts/console.js';
import type { LogQuery } from '../../../../../shared/contracts/logs.js';

export interface LogCursor {
  time: string;
  id: string;
}

export type LogRow = Omit<DeviceLog, 'received_at' | 'device_time'> & {
  received_at: Date;
  received_at_exact?: string;
  device_time: Date | null;
};

export interface LogDetail extends Record<string, unknown> {
  raw_data?: string | null;
}

export interface LogReader {
  list(
    org: string,
    q: LogQuery,
    from: string,
    to: string,
    cursor: LogCursor | undefined,
  ): Promise<LogRow[]>;
  detail(org: string, id: string): Promise<LogDetail | undefined>;
}
