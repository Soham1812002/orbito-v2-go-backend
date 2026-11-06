# Fleet device console

This project has two pages: one to register vehicles and their GPS trackers, and another to read decoded device messages. Express serves both pages. A Go service handles device connections, PostgreSQL stores the data, and a separate Socket.IO service sends live updates.

## What you need

- Docker Engine and Docker Compose v2.
- Node.js 22 or newer to run the local setup helper.
- Internet access for the first Docker build, unless the images and dependencies are already cached.
- Ports 8080, 5001 and 5002 available on your machine.

You do not need Go or PostgreSQL installed on the host when using Docker.

## 1. Create your local settings

From the project directory, run:

```bash
node scripts/setup-local.mjs
```

This creates a private `.env` file with random database, service and demo-account passwords. It sets the website address to `http://localhost:8080`. If `.env` already exists, the helper leaves it alone.

Keep `.env` out of Git. If you already have one, compare it with `.env.example`. The smoke test needs `DEMO_EMAIL` and `DEMO_PASSWORD` as well as the database and service settings. Use a random password of at least 12 characters for the demo account.

If you change the website port, change both `HTTP_PORT` and `PUBLIC_ORIGIN`. For example, port 8090 needs `PUBLIC_ORIGIN=http://localhost:8090`.

## 2. Start the containers

```bash
docker compose up --build -d
docker compose ps
```

The first build may take a few minutes. Docker starts PostgreSQL, runs the database migrations, then starts the API, Socket.IO server, GPS gateway and Nginx. The migration container should finish with exit code 0; it does not keep running.

To check startup problems:

```bash
docker compose logs --tail=100 migrate api realtime gateway nginx
```

The login page is at [http://localhost:8080/login](http://localhost:8080/login). You still need an account; the next step creates a separate demo workspace for testing.

## 3. Send mock data and check the responses

With the stack running:

```bash
docker compose run --rm --build smoke
```

The smoke test uses real HTTP requests and the running PostgreSQL database. It:

- Checks the login page through Nginx and confirms private endpoints are blocked there.
- Creates or reuses the demo administrator, signs in and reads the CSRF token.
- Adds a vehicle with a synthetic IMEI through the API.
- Checks invalid input, duplicate registration and missing authentication.
- Sends a location, heartbeat, delayed location and invalid-checksum diagnostic to the internal ingestion API.
- Resends a location to check duplicate handling.
- Reads the decoded logs back through the API and checks pagination.
- Checks that delayed data did not replace the latest location or ignition state.
- Checks tenant isolation, viewer permissions and raw-data redaction.
- Waits for the saved-log notifications through the outbox, Nginx and Socket.IO.

Each completed check prints `PASS`. The script exits with an error if a response or stored result is wrong. A successful run ends with a summary containing:

```json
{
  "passed": true,
  "savedLogs": 4,
  "savedPositions": 2
}
```

This flow was verified on 6 November 2026: all 12 smoke checks passed against the running Docker stack, with four logs and two positions for each test device. The eight Node tests also passed with real PostGIS, and Go vet, race tests and a short parser fuzz run passed.

The mock messages start at the **normalized API event** stage. They are clearly marked as simulated. This checks the backend, database and live delivery; it does not validate the Go wire parsers, a real CRC or physical tracker acknowledgements.

The test only runs with `NODE_ENV=development` and its explicit demo flag. It keeps the demo vehicle and messages so you can inspect them. Each run adds another vehicle with a fresh IMEI. Temporary permission-test users and their sessions are removed afterward. A failed run may leave a partially populated demo vehicle for inspection. Do not use this command against production.

## 4. Open the two pages

Open [http://localhost:8080/login](http://localhost:8080/login) and sign in using `DEMO_EMAIL` and `DEMO_PASSWORD` from your local `.env` file. The smoke test creates that account; the setup helper alone does not.

- **Vehicles:** find the demo delivery van, or add a vehicle with its name, number, tracker IMEI, model and protocol profile.
- **Device logs:** select its tracker and inspect the location, heartbeat, history and diagnostic messages. Use Details to see the decoded JSON. Raw data is restricted to administrators.

If you change `DEMO_PASSWORD` after the account has been created, it will not reset the account password. The smoke test intentionally does not overwrite an existing password.

### Create your own administrator instead

For a separate workspace, enter the credentials in your shell and pass them to the bootstrap command:

```bash
read -r -p 'Admin email: ' ADMIN_EMAIL
read -r -s -p 'Admin password (at least 12 characters): ' ADMIN_PASSWORD
export ADMIN_EMAIL ADMIN_PASSWORD
docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD api node --import tsx scripts/create-admin.ts
unset ADMIN_EMAIL ADMIN_PASSWORD
```

This creates a new administrator and organization. It does not reset an existing account. The demo account is enough for the mock-data walkthrough.

## Connect a real tracker

Register its details first, then use the manufacturer's supported configuration method to set the server address and port:

| Tracker | Server port |
|---|---|
| Markon / AIS-140 | TCP 5001 |
| Supported Concox profile | TCP 5002 |

Many devices can share the same port. Login, location, heartbeat and supported alarm messages use the device's existing TCP connection; there is no separate port for each update type.

Use an address the tracker can reach over its SIM connection. `localhost` only refers to the machine making the connection. Saving a vehicle in the console does not configure the hardware.

The supplied PDFs are under `.docs/`. Actual model and firmware captures are still needed before declaring a profile production-ready. Markon's NRM checksum algorithm is missing from the supplied document, so Markon admission is disabled by default. `ALLOW_UNVERIFIED_MARKON=true` explicitly enables diagnostic use in both services; it does not make the checksum verified. Unsupported packet variants and remote commands remain disabled. IMEI identifies a device but is not strong authentication.

## Stop, restart or update

Stop the containers without removing them:

```bash
docker compose stop
```

Start them again:

```bash
docker compose start
```

After changing application code:

```bash
docker compose up --build -d
```

Database and gateway queue data live in named volumes. `docker compose down` removes the containers but keeps those volumes. Avoid `docker compose down -v` unless you deliberately want to delete the stored data.

## Common startup problems

**Docker says permission denied or cannot connect to the daemon.**

Make sure Docker is running and that your terminal can run `docker ps`. In a managed coding session, Docker socket access may be blocked by the session policy even when Docker works in your own terminal. That restriction must be resolved before this stack can be started there.

**The API cannot connect to PostgreSQL after changing the password.**

An existing database volume keeps its original password. Changing `POSTGRES_PASSWORD` in `.env` does not change the password inside an initialized database. Use the original setting or perform an intentional password change; do not delete the volume to fix this by accident.

**Login or saving a form returns 403.**

Open the address in `PUBLIC_ORIGIN` exactly. `localhost` and `127.0.0.1`, or different ports, count as different origins. The application checks the origin and CSRF token.

**The smoke test cannot sign in.**

Check the demo credentials in `.env`. The script will not replace an existing non-demo user or reset an existing demo password. Read the first failed check rather than repeatedly retrying login.

**A build cannot download an image or npm package.**

Check the Docker host's internet connection and registry access. A successful Compose configuration check does not mean the images have been downloaded or built.

## Run the code checks

For checks outside Docker:

```bash
npm ci --ignore-scripts
npm run check
npm run format:check
npm test
```

On restricted hosts where test subprocesses cannot bind local sockets, try `npm run test:local`.

The real PostGIS integration test needs a disposable test database supplied through `DATABASE_TEST_URL`; it is skipped without one. Go checks require the Go toolchain, or run during the gateway's Docker build. The test files run sequentially to stay within the small container’s process limit. CI configuration is in `.github/workflows/checks.yaml`.

## Before putting it on a public server

The default Compose setup is local HTTP development. For HTTPS, `compose.production.yaml` and `infra/nginx/production.conf.template` expect an existing certificate directory and ACME webroot. Set `NODE_ENV=production`, an HTTPS `PUBLIC_ORIGIN`, `FLEET_DOMAIN`, `HTTP_PORT=80`, `CERTIFICATE_DIR` and `ACME_WEBROOT`, then use both Compose files. Certificate issuance and renewal are managed separately.

Expose only the required web and tracker ports. PostgreSQL, API, realtime and gateway health ports should stay private. Back up PostgreSQL off the VM and test restoring it. The single-VM setup and local gateway queue do not guarantee zero data loss. Public multi-tenant deployment also needs least-privilege database roles and the remaining hardening described in the plan.

## Design and validation notes

The approved plan is [.docs/IMPLEMENTATION_PLAN.md](.docs/IMPLEMENTATION_PLAN.md). Project coding conventions are in [skills/fleet-conventions/SKILL.md](skills/fleet-conventions/SKILL.md).

The implementation uses parameterized PostgreSQL queries, checked migrations, built-in scrypt password hashing and hashed server-side sessions. The initial gateway queue uses fsynced files. These keep the first version small; the storage and queue limits need benchmarking before scaling it up.

For the current Docker test attempt and its actual result, see [qa-artifacts/docker-smoke/report.md](qa-artifacts/docker-smoke/report.md). The current browser check against the running Docker application, with screenshots, is in [qa-artifacts/docker-ui/report.md](qa-artifacts/docker-ui/report.md). The older fixture-only UI report remains under `qa-artifacts/initial-ui/` for reference.
