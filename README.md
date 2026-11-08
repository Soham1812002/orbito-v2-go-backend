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
  proxy/                     HTTP routing for pages, API and Socket.IO
    Dockerfile
    nginx.conf
shared/                      Transport contracts, errors, security and logging
utils/
  scripts/                   Setup, migration, administrator and smoke commands
  eslint/                    Architecture lint rule
tests/                      Unit, HTTP, Socket.IO and PostGIS tests
compose.yaml                 One HTTP-only Docker Compose configuration
```

Each custom service owns its Dockerfile. Backend and realtime builds use the repository root as their build context because they use `shared/` and the root lockfile. The gateway and proxy use their own service directories as build contexts. PostgreSQL uses the existing PostGIS image directly.

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
- Concox alarm `0x26` has a decoder for specific documented layouts. Unsupported layouts, language/ACK ambiguities and other unenabled variants remain diagnostics; the gateway does not invent an acknowledgement.
- Which alarms a real tracker sends depends on its model, firmware, sensors and configuration. Registering a tracker does not prove support for SOS, power-cut, overspeed or any other particular alarm.
- A separate server-calculated alert/rule engine and SMS/email/push delivery are outside the current two-page scope. Received hardware alarms are available in the decoded log page.

The protocol PDFs and evidence/gaps are in `.docs/` and [.docs/IMPLEMENTATION_PLAN.md](.docs/IMPLEMENTATION_PLAN.md). IMEI is an identifier, not authentication. Test the actual hardware/firmware before declaring a profile supported.

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
