# Fleet device console

Two Express-served pages manage vehicles and their GPS trackers and display persisted decoded device messages. A Go gateway receives tracker traffic, PostgreSQL/PostGIS stores it, and a separate Socket.IO service delivers live notifications.

## Project structure

```text
services/
  backend/                   Express API, business modules, pages and migrations
    Dockerfile
  realtime/                  Separate Socket.IO application
    Dockerfile
  gateway/                   Go TCP listeners, decoders and durable spool
    Dockerfile
  database/                  PostGIS image with the shared log runner
    Dockerfile
  proxy/                     HTTP routing for pages, API and Socket.IO
    Dockerfile
    nginx.conf
shared/                      Transport contracts, errors, security and logging
utils/
  scripts/                   Setup, migration, administrator and smoke commands
  eslint/                    Architecture lint rule
  logging/                   Static container log runner and rotation tests
tests/                      Unit, HTTP, Socket.IO and PostGIS tests
compose.yaml                 One HTTP-only Docker Compose configuration
```

Each service owns its Dockerfile. Builds use the repository root as context so every image can include the shared static log runner from `utils/logging/`. The database image extends PostGIS only to add this runner; the database data volume and PostgreSQL entrypoint remain in use.

Runtime code stays in feature modules and `shared/`; `utils/` holds operational and development tools. It is not a generic container for business logic.

## Start locally

You need Docker Engine/Compose v2, Node.js 22.18 or newer for the setup helper, and available TCP ports 80, 5001 and 5002. Docker provides Go and PostgreSQL; neither needs to be installed on the host.

```bash
node utils/scripts/setup-local.ts
docker compose up --build -d --wait
docker compose ps
```

The helper creates a private `.env` with independent random secrets and `PUBLIC_ORIGIN=http://localhost`. It preserves an existing file. When reusing older settings, set `PUBLIC_ORIGIN` to `http://localhost` or your actual HTTP hostname. The old `HTTP_PORT`, certificate and domain-substitution settings are no longer used.

Open [http://localhost/login](http://localhost/login). Keep `.env` out of Git; `.env.example` documents the settings. Container addresses are set explicitly in Compose. `PUBLIC_ORIGIN` must match the browser address because mutations check both Origin and CSRF.

There is one Compose file and one HTTP listener on port 80. No HTTPS override or port 443 is configured. The existing Compose project name and persistent volume names are retained.

## Create demo data or an administrator

With the stack running:

```bash
npm run smoke:docker
```

The smoke tool creates or reuses the isolated demo administrator from `.env` (`DEMO_EMAIL` and `DEMO_PASSWORD`), registers a synthetic tracker, and verifies ingestion, replay handling, history, permissions and Socket.IO delivery. It runs only in development with an explicit demo flag, preserves demo messages for inspection, and never resets an existing password. Sign in with those credentials afterward. Setup alone does not create an account.

The mock data enters the normalized internal API. It does not establish hardware parser, CRC or acknowledgement correctness.

For a separate organization, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your shell, then run:

```bash
docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD backend node utils/scripts/create-admin.js
```

The password must be at least 12 characters. The command creates a new organization and administrator; it does not reset an existing user. Remove the password from the shell afterward.

## Ports and device communication

| TCP port | Exposure            | Purpose                                                   |
| -------- | ------------------- | --------------------------------------------------------- |
| 80       | Published           | Website, REST API and browser Socket.IO through the proxy |
| 5001     | Published           | Supported Markon/AIS-140 tracker traffic                  |
| 5002     | Published           | Supported Concox tracker traffic                          |
| 3000     | Docker network only | Backend API and internal gateway/realtime requests        |
| 3001     | Docker network only | Socket.IO service                                         |
| 5432     | Docker network only | PostgreSQL/PostGIS                                        |
| 8081     | Docker network only | Gateway management and health                             |

Port 5001/5002 values are deployment choices, not manufacturer-mandated defaults. Configure each registered tracker with the server's reachable IP/domain and the correct protocol port using the manufacturer's supported procedure. Saving a vehicle does not configure the hardware.

Our implemented tracking channel accepts supported Markon login, heartbeat, location and device-event packets on **TCP port 5001**, and supported Concox packets on **TCP port 5002**. Many trackers share each listener; each has its own connection/session and registered identity. No separate port is needed per device, per location update, or per alarm. Protocol-required replies return on the existing connection. There is no UDP listener in this implementation.

This describes the tracking channel implemented here, not every function of a physical tracker. The Concox flow diagram shows location, heartbeat and alarm traffic sharing the connected backend session (PDF p. 35). The Markon PDF separately describes government-server emergency EPB messages (pp. 5, 28-29) and emergency SMS (p. 30); it does not explicitly guarantee that every output uses one TCP endpoint. Actual government/auxiliary endpoint configuration needs vendor or hardware evidence. See [.docs/PROTOCOL_TRANSPORT_REVIEW.md](.docs/PROTOCOL_TRANSPORT_REVIEW.md) for the page-by-page verification.

Different packet types carry different fields. A heartbeat may contain battery/network status without a GPS position. A location packet may contain position, speed and ignition. A hardware alarm uses its protocol's event/alarm fields; it does not imply every possible field is present.

### Alerts and current support

The gateway reads packet types and preserves device-provided alert identifiers/codes in `protocolData`. Accepted device events are persisted as decoded logs and delivered to authorized browsers through the same outbox/Socket.IO flow as other messages.

- Markon NRM decoding preserves `alertId` and packet type. Its checksum algorithm is still unverified, and admission is disabled by default. `ALLOW_UNVERIFIED_MARKON=true` explicitly enables diagnostic use; it does not verify the checksum. EPB framing/checksum support remains disabled.
- Concox `0x94/00` is decoded as a `STATUS` event with `externalPowerVoltage` in volts (the two-byte value divided by 100). It has no GPS position or device timestamp and requires no ACK, as specified on PDF pp. 26/31. Other information subtypes remain diagnostics.
- Heartbeat flags preserve charging, tracking, defense and fuel/electricity-cutoff status. The tracking flag reports device state; it is not a remote GPS-enable setting. EG02/EG03 external voltage uses `externalPowerVoltage`; older records may still use the legacy `batteryVoltage` field.
- The log summary shows available coordinates, speed, heading, GPS-fix state, voltage and heartbeat flags. Absent coordinates are labeled "Position not provided"; zero speed/voltage and false flags remain visible. Optional mileage is shown as a raw counter with its unit explicitly unspecified.
- Valid unsupported packets are retained without consuming the corruption allowance. Eleven consecutive malformed/invalid-checksum inputs still terminate a session; valid inputs reset that streak. Structured packet logs include decode/checksum status and packet length, and session closure includes `closeReason` (for example `peer_reset`, `peer_eof`, `read_timeout` or `malformed_limit`).
- Concox alarm `0x26` has a decoder for specific documented layouts. Unsupported layouts, language/ACK ambiguities and other unenabled variants remain diagnostics; the gateway does not invent an acknowledgement.
- Which alarms a real tracker sends depends on its model, firmware, sensors and configuration. Registering a tracker does not prove support for SOS, power-cut, overspeed or any other particular alarm.
- A separate server-calculated alert/rule engine and SMS/email/push delivery are outside the current two-page scope. Received hardware alarms are available in the decoded log page.

These decoder changes apply to newly received packets. Previously stored diagnostics remain unchanged; there is no automatic replay or database migration for this update. The changes do not make a tracker send location packets and do not introduce device configuration commands.

The protocol PDFs and evidence/gaps are in `.docs/` and [.docs/IMPLEMENTATION_PLAN.md](.docs/IMPLEMENTATION_PLAN.md). IMEI is an identifier, not authentication. Test the actual hardware/firmware before declaring a profile supported.

## Operational logs and tracing

Logging starts automatically with `docker compose up -d --build --wait`. All application levels are enabled by default (`LOG_LEVEL=trace`): `trace`, `debug`, `info`, `warn`, `error`, and `fatal`. Lower-volume deployments can set `LOG_LEVEL=info`. Native database and proxy diagnostics retain their normal infrastructure verbosity; application debug does not enable SQL statement or raw packet logging.

Each container writes JSON Lines to the console and to its own directory on the **host running Docker**:

```text
logs/backend/current.jsonl
logs/realtime/current.jsonl
logs/gateway/current.jsonl
logs/proxy/current.jsonl
logs/database/current.jsonl
logs/migrate/current.jsonl
logs/smoke/current.jsonl       # when the optional smoke tool runs
```

`LOG_HOST_DIR` defaults to `./logs` beside Compose. Set it to an absolute path such as `/var/log/fleet` for a hosted instance. Files survive container replacement and are excluded from Git and image build contexts. `log-init` prepares service-specific directories; on Linux set `LOG_GID` to your operator group ID for read access. Files are mode 0640 and directories 2750, subject to host filesystem support. Container users retain ownership of their own directories.

Defaults are 10 MiB per file (`LOG_MAX_BYTES=10485760`), five numbered archives (`LOG_MAX_FILES=5`) and seven days (`LOG_RETENTION_DAYS=7`). Rotation occurs by size/age; expired archives are cleaned at startup, rotation and periodic maintenance. Retention is file-based, not deletion of individual old records inside an active file. Every service has an independent writer and bounded buffer. Disk errors fall back to console diagnostics; sustained output congestion can drop records with a warning rather than block tracker ingestion. These logs are diagnostic records, not a lossless audit archive.

Records contain UTC `timestamp`, string `level`, `service`, `environment`, `event`, `message` and `outcome`, with operation IDs and duration where available. `outcome` distinguishes success, failure, rejection, duplicate handling and retries. A successfully processed hardware alarm is not an application error. Infrastructure records are normalized, but native PostgreSQL messages do not carry application trace IDs.

Gateway intake creates a trace per packet, preserves it in the durable spool, and propagates it through authenticated internal HTTP. The backend persists the trace and original packet event ID with the outbox in the same transaction; delivery retries and realtime emissions retain that trace after restart. `ingestionEventId` identifies the original packet; `outboxId` identifies its notification. Existing realtime `eventId` semantics remain unchanged. Legacy records without tracing metadata remain readable. A tracker retransmission can start a new trace; duplicate handling is logged. Socket emission does not prove that a browser rendered the notification.

Public requests receive server-owned trace IDs. The proxy supplies the request ID; API responses expose `X-Request-ID` and `X-Trace-ID`. Internal calls use validated W3C `traceparent` after service authentication. Trace IDs are correlation metadata and grant no access.

```bash
docker compose logs -f backend gateway realtime
npm run logs:query -- --trace <traceId>
npm run logs:query -- --service gateway --level error
npm run logs:query -- --event ingestion.committed
```

The query tool streams matching JSONL records from host files; output follows file order rather than guaranteed causal ordering. Running Node services directly outside Docker writes structured console logs; automatic host-file capture is supplied by the container runner.

Operational logging uses an allowlist and safe error type/code fields. It excludes credentials, cookies, authorization headers, raw packets, SIM information, coordinates, full IMEIs and SQL parameters. Detailed device payloads remain in the existing access-controlled device log storage. Native infrastructure failure text is summarized to avoid embedding request input or SQL. Business audit records and the durable spool remain separate.

## Architecture and code quality

The Node request flow is route → controller → service → repository. Services receive typed actors and narrow dependencies; repositories own parameterized multiline SQL. Bootstrap binds all repositories in a registration, replacement or ingestion operation to the same PostgreSQL client, preserving transaction and lock boundaries.

Realtime separates its backend client, socket authentication/session lifecycle and fanout decisions. Browser modules separate API response decoding, forms, rendering and live state. Entry URLs remain `common.js`, `vehicles.js`, `logs.js` and `login.js`; these are compiled from TypeScript.

| Configuration                     | Responsibility                                                          |
| --------------------------------- | ----------------------------------------------------------------------- |
| `eslint.config.ts`                | Lint rules, spacing between logical blocks and architecture enforcement |
| `utils/eslint/architecture.ts`    | Dependency and SQL-placement checks                                     |
| `prettier.config.ts`              | Consistent indentation, wrapping and EJS formatting                     |
| `.editorconfig`, `.gitattributes` | Editor defaults and consistent line endings                             |
| `tsconfig.json`                   | Node type checking, tests and tooling                                   |
| `tsconfig.build.json`             | Production server output, excluding tests/tooling/browser source        |
| `tsconfig.browser.json`           | Browser DOM types and compiled modules                                  |
| `package-lock.json`               | Reproducible dependency versions for `npm ci`                           |

```bash
npm ci --ignore-scripts
npm run fix
npm run quality
npm run build
npm test
```

`fix` applies lint fixes and formatting. `quality` checks both Node/browser types, lint and formatting without changing files. CI runs these checks, the build, tests, Go formatting/vet/race/fuzz checks and the Docker smoke flow. Existing SQL migrations are checksum-protected and are not reformatted. Preserve the narrow formatter-ignore marker on the dynamic EJS title; rendering tests guard it.

Browser source is in `services/backend/src/browser/`, with generated modules under ignored `dist/services/backend/src/public/`. For host development, run `npm run dev:api` and `npm run dev:browser` in separate terminals. The API listens on 3000 when run directly; set `PUBLIC_ORIGIN` to the actual direct API address if bypassing Docker's proxy. Start the separate realtime process with `npm run dev:realtime` when needed.

PostGIS tests need a disposable database supplied through `DATABASE_TEST_URL`; they visibly skip without one. The tests cover service policies, registration/replacement rollback and concurrency, tenant isolation, tickets, ingestion history, outbox retries/leases, retention, real Socket.IO behavior and safe templates. CI provides PostGIS.

Architecture details and the prior refactor verification record are in [.docs/NODE_REFACTOR_PLAN.md](.docs/NODE_REFACTOR_PLAN.md).

## Gateway load and recovery verification

Run `npm run stress:gateway` with Node.js and Docker available. It builds test images, creates an isolated network/database/spool with no published ports, registers synthetic devices through the API, and sends real Concox TCP frames. It checks exact ACKs, decoded fields, stored raw hashes, PostGIS axes, every REST page, intentional GPS retransmission deduplication, notification drain and recovery after backend pause plus gateway SIGKILL. It never uses the running fleet database or `.env` credentials. The harness is included only in the explicit `load-test` Docker build target; the default backend image excludes it.

The default test uses 50 devices and three four-packet rounds per phase. Change the size with `LOAD_DEVICES=10 LOAD_ROUNDS=2 npm run stress:gateway` in a POSIX shell, or set those environment variables in PowerShell before running the command. `LOAD_DEVICES=256 LOAD_ROUNDS=1 npm run stress:gateway` is a bounded capacity probe that can intentionally fail on ACK timeout; it is not a supported capacity claim. Heartbeat, location, voltage and alarm layouts come from the PDF/captured heartbeat; IMEI, serial and UTC are synthetic. The harness ACK deadline is 15 seconds from batch transmission, not a verified tracker timeout.

| Test container | CPU quota | Memory limit |
| -------------- | --------- | ------------ |
| Gateway        | 0.5 core  | 256 MiB      |
| Backend        | 0.5 core  | 384 MiB      |
| PostGIS        | 0.5 core  | 384 MiB      |
| Realtime       | 0.25 core | 128 MiB      |
| Sender         | 0.25 core | 192 MiB      |

The runtime total is capped at 2 CPU cores and 1,344 MiB, with no additional swap allowance. Builds run serially; compiler resource use is separate from these runtime quotas. Reports, samples, manifests and stopped-spool evidence go into ignored `.tmp/gateway-load/`. Labeled test containers/networks/volumes are removed afterwards. The audit merges database and spool identities, deduplicating retry overlap; failed probes retain evidence rather than reporting every sent byte as committed. Notification acceptance is a refresh hint; browsers recover saved history through REST.

See [.docs/GATEWAY_LOAD_RESULTS.md](.docs/GATEWAY_LOAD_RESULTS.md) for measured results and limits. The Go service uses four bounded forwarding workers and preserves each device's queue order. A delayed packet blocks its own device, while other devices can progress. The spool rebuilds an in-memory index at startup and rejects a second process owner. Stored logs include parser revision; old events default to revision 1.

Optional `.env` settings are `MAX_CONNECTIONS=256`, `FORWARD_WORKERS=4` (1?8), `REGISTRY_TIMEOUT=3s` (maximum 5s), `LOGIN_TIMEOUT=15s`, `IDLE_TIMEOUT=180s`, `FRAME_TIMEOUT=15s`, and `SPOOL_MAX_BYTES=1073741824`. Compose also sets CPU and memory limits for regular services. Updates apply migration `003_outbox_lease_token.sql` automatically through the existing migrate service; applied migrations remain unchanged.

To inspect or replay quarantine, stop the gateway first. Fix the underlying registration/configuration/schema issue before retrying. Replay preserves event ID and normalized bytes; it does not re-decode old raw packets.

```bash
docker compose stop gateway
docker compose run --rm --no-deps --entrypoint /spoolctl gateway
# Select a filename returned by the inspection command:
docker compose run --rm --no-deps --entrypoint /spoolctl gateway -replay 'http_422--FILENAME.json'
docker compose up -d gateway
```

Malformed JSON and interrupted writes require inspection; they are not automatically replayed. Quarantine remains within spool capacity. Disk-full/permission/sync failures prevent a successful admission ACK; local disk destruction and tracker packets never received are outside the durability guarantee.

## Images, data and routine operations

Node Dockerfiles use multi-stage Alpine builds and keep compiled JavaScript, assets and production dependencies in the runtime. Development dependencies, source TypeScript, tests and build caches are excluded. The gateway runs a stripped static Go binary in `scratch` with CA certificates and a writable non-root spool directory. The proxy uses Nginx Alpine. BuildKit caches npm downloads and Go compilation.

```bash
docker compose build
docker compose images
docker compose logs --tail=100 migrate backend realtime gateway proxy
docker compose stop
docker compose start
```

After application changes:

```bash
docker compose up --build -d --remove-orphans
```

Database and spool data live in persistent named volumes. `docker compose down` retains them; `docker compose down -v` deliberately deletes them. An existing PostgreSQL volume retains its original password: changing `.env` does not change the initialized database password. Docker must be running before the stack can build or start.

Git and Docker contexts ignore local dependencies, secrets, generated output, logs, caches, editor files and test artifacts. Keep shared configuration and the lockfile tracked. Raw tracker data and operational secrets must not be committed or printed in logs.
