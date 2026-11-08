export interface OutboxEntry {
  id: string;
  organization_id: string;
  device_id: string;
  log_id: string;
}

export interface OutboxStore {
  claim(): Promise<OutboxEntry[]>;
  delivered(id: string): Promise<void>;
  retry(id: string): Promise<void>;
}
