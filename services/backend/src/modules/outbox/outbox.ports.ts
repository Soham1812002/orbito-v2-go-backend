export interface OutboxEntry {
  id: string;
  lease_token: string;
  organization_id: string;
  device_id: string;
  log_id: string;
  ingestion_event_id?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  attempts?: number;
}

export interface OutboxStore {
  claim(): Promise<OutboxEntry[]>;
  renew(id: string, token: string): Promise<boolean>;
  delivered(id: string, token: string): Promise<void>;
  retry(id: string, token: string): Promise<void>;
}
