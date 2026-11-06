# Docker and API smoke-test results

Date: 2026-11-06

**Status: PASS.** Docker access is now available. The stack was built, migrations completed and the five long-running fleet services were left running. This replaces the earlier blocked result.

## Verified results

| Check | Observed result |
| --- | --- |
| Fresh Node image install | `npm ci` installed150 packages successfully |
| Gateway image build | Parser/spool tests and executable build passed |
| PostgreSQL / PostGIS | Healthy; initial migration applied; later migration runs exited0 without reapplying |
| Normalized-event Docker smoke | All12 checks passed, twice; final run after fixes also exited0 |
| Full Node tests with PostGIS | Eight passed, zero skipped, using an isolated temporary schema |
| Go vet and race tests | Passed in a resource-limited Go container |
| Parser fuzz | Passed:100,855 executions in approximately3 seconds, no failing input |
| TypeScript and formatting | Passed |
| Actual browser | Login, saved vehicle, four decoded messages, details and reconnect passed; zero page errors or failed requests |

## API behavior checked

- Readiness and login page returned200; Nginx blocked a private route with404.
- Anonymous vehicle/internal-event requests returned401.
- Missing CSRF returned403; bad registration or a supplied tenant field returned422.
- Vehicle registration returned201; duplicate registration returned409.
- Gateway registry returned the enabled registered device and its expected profile.
- Valid normalized location returned200 with matching eventId, persisted=true and duplicate=false.
- Repeating the request and a source retransmission returned duplicate=true without extra rows.
- Heartbeat, delayed location and invalid-checksum diagnostic were stored correctly.
- Invalid location fields returned422; wrong profile and unregistered device returned409.
- There were exactly four decoded logs, two GPS positions and four receipts per test device.
- The delayed position and ignitionOFF did not replace the newest position or ignitionON.
- Log list/detail and cursor pagination returned the expected records.
- A different tenant could not read the log detail (404); viewer writes returned403; raw data was omitted for viewers.
- A single-use ticket authenticated Socket.IO, and committed outbox notifications arrived through Nginx.

These are assertions executed against the real Docker API/database, not mocked response claims. Event payloads themselves are explicitly synthetic and enter after normalization. Physical device packets, cellular connectivity and hardware ACK behavior were not tested.

## Fixes found during the run

1. Browser same-origin polling GETs can omit Origin. The realtime server incorrectly rejected them with403. It now accepts an absent or matching Origin while still requiring a valid single-use ticket, and rejects explicit foreign origins. Regression coverage checks the absent-Origin path, foreign-Origin rejection and invalid-ticket rejection.
2. The setup helper test inherited the Node test-worker context and launched unbounded subprocesses. It now clears that context and applies a10-second subprocess timeout.
3. Parallel test workers exceeded the small container’s128-process limit. `npm test` now runs files sequentially. The full suite then passed, including the previously skipped database test.
4. Gateway source was formatted with gofmt; gateway build, vet, race and fuzz checks passed.

## Retained demo data

The demo workspace is `Fleet demo workspace`; login is `demo@fleet.local`. Its password stays in `.env` under DEMO_PASSWORD and was not printed in test output.

Final smoke run:

- Vehicle: `00664e8e-bf59-41e1-85f9-6909e8128d75`
- Device: `f1603ab0-64b6-412e-945d-d27dceb65a64`
- Synthetic IMEI: `993710143385020`
- Saved logs:4; saved positions:2; checks:12.

The first run’s device (`994716369227861`) is also retained and was used for the browser screenshots. Each has four messages. Temporary permission-test users and their sessions were cleaned up. Test database schemas were dropped. Other pre-existing Docker applications were not modified.

## Commands used

```bash
docker compose up --build -d
docker compose run --rm --build smoke
```

The complete Node suite was run in a disposable API container with the test folder mounted read-only and DATABASE_TEST_URL set to the container’s existing database URL. It created/dropped a uniquely named schema. Go checks used a separate container with no network,1GiB RAM,2 CPUs and a read-only source mount.

Website: http://localhost:8080/login. The services remain running for inspection. See README.md for setup and repeat commands, and ../docker-ui/report.md for the browser evidence.
