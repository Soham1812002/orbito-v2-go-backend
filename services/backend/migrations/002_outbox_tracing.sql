ALTER TABLE realtime_outbox
  ADD COLUMN ingestion_event_id uuid,
  ADD COLUMN trace_id text CHECK (trace_id ~ '^[a-f0-9]{32}$'),
  ADD COLUMN span_id text CHECK (span_id ~ '^[a-f0-9]{16}$');
