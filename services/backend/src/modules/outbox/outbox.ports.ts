export interface OutboxEntry {
  id: string;
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
  delivered(id: string): Promise<void>;
  retry(id: string): Promise<void>;
}
