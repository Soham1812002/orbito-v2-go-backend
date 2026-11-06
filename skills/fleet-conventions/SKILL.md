---
name: fleet-conventions
description: Implement or review this fleet repository's gateway, Express pages/API, realtime service and migrations while preserving protocol evidence, tenant isolation and ingestion durability.
---

Read .docs/IMPLEMENTATION_PLAN.md and the relevant source module before changing behavior. Apply this skill to fleet application work, not unrelated tasks.

- Keep Go wire parsers independent of Express, database entities and browser code. Select protocol/model profiles explicitly. Missing manufacturer facts remain unsupported or visibly unverified; never invent CRCs, ACKs or command formats.
- Keep the Express API and Socket.IO processes separate. Express serves EJS pages with escaped output; browser scripts use textContent for device data. No React, Kafka or Redis for the initial two-page application.
- Validate public and internal inputs using shared contracts. Treat IMEI as a string identifier, not authentication. Resolve tenant and assignment on the server. Scope every record lookup, detail endpoint and room subscription.
- Vehicle/device creation, assignments, audit and ingestion effects are transactional. Enforce uniqueness/assignment overlap in PostgreSQL. Retry identity is stable; duplicate or historical events must not rewind state.
- ACK only documented packet types after durable local admission. HTTP persistence success follows commit; websocket delivery follows persistence and is recoverable by REST resync.
- Keep routes thin, business transactions in modules, shared HTTP/security mechanics in named helpers. Avoid catch-all classes or speculative abstractions. Add a migration for database changes; do not edit deployed migrations.
- Run npm run check and relevant tests; run Go tests/race for gateway changes and real PostGIS integration tests for transactions/spatial changes when available. Browser QA covers actual forms/log rendering/reconnect. Report unavailable checks plainly.
- Keep secrets/raw SIM information out of logs and commits. Update README and protocol support notes when capabilities or run commands change.
