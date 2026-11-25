# GT06N integration plan and evidence

Date: 2026-11-25. Implementation is authorized. Scope: a separate `concox-gt06n-v1` profile on the existing Concox TCP listener (5002), using the existing canonical events, durable spool, ingestion transactions and realtime outbox. No new service, database schema, command sender or general plugin framework is needed.

## Implementation sequence

1. Add a dedicated GT06N decoder sharing only binary envelope/CRC, BCD identifier and ACK helpers. Accept exact documented login, location, heartbeat and alarm layouts. Existing profiles must not accept the new layouts.
2. Identify the first Concox login without choosing a model, resolve the registered profile, then decode the original frame under that profile before binding or acknowledging. Reject unknown, disabled and mismatched registrations and identity changes.
3. Add the profile to registration contracts and operator guidance. Keep device time unverified by default; an optional, validated GT06N-only UTC offset permits canonical timestamps after operators confirm their firmware configuration. Preserve local time and uncertainty in decoded details. Give GT06N's documented three-minute heartbeat a four-minute minimum idle timeout without changing existing profile timeouts.
4. Verify document vectors and edge cases, then send demo frames through real TCP sessions, durable forwarding and an isolated PostGIS-backed backend. Exercise existing profiles alongside GT06N, profile isolation, CRC/malformed rejection, duplicate/delayed events and tenant scoping. Fix failures and rerun relevant checks.
5. Update support notes and reproducible QA commands/results. Actual hardware/model/firmware validation remains a release gate.

## Source evidence

Source supplied by the user: `gt06n new version protocol[Copy].pdf`, retained as [GT06N_protocol.pdf](GT06N_protocol.pdf) (43 physical pages), SHA-256 `7cb93bf6cbebe27788ff74c050f94f1409b8fa5d36faf37fd71716c678b555cc`. Page references below use printed page numbers; physical PDF page = printed page + 1. The filename identifies GT06N; the document itself has a generic Concox GPS Tracker title, so it does not establish universal GT06N firmware compatibility.

| Area | Evidence | Implementation boundary |
| --- | --- | --- |
| Envelope / CRC | pp.8–9; appendix A p.37 | Ordinary `7878`, one-byte length, CRC from length through serial; reflected 0x8408, initial FFFF, final complement. Do not enable other envelope variants for this profile. |
| Login | pp.9–11 | `0x01`, eight-byte packed-decimal identifier only; ACK echoes protocol and serial. |
| Location | pp.12–16 | `0x12`, 26-byte body, optionally four mileage bytes. Coordinates /1,800,000; speed km/h. No location reply is specified in this flow. Mileage unit is unverified. |
| ACC / fix | pp.14–15 | Course bit 14 makes bit 15 ACC valid; bit 12 is fix, bit 11 west, bit 10 north, low 10 heading. Differential bit 13 is not a historical-upload marker. |
| Alarm | pp.17–21 | `0x16`, 32-byte body including LBS length 9 and terminal/battery/GSM/alarm/language fields; simple ACK documented. Preserve both terminal alarm bits and separate alarm code. Address/SMS replies remain unsupported. |
| Heartbeat | pp.24–26; appendix B p.38 | `0x13`, five-byte body; categorical battery 0–6/GSM 0–4, terminal flags and alarm/language. ACK echoes request serial. |
| Timing | p.6 | Three-minute status interval and five-second reply language. Use a four-minute minimum idle timeout for this profile; measure login/heartbeat ACK latency on real firmware. |
| Time / history | p.13, course fields pp.14–15 | Calendar bytes and year base 2000 are specified, UTC offset and a backlog flag are not. Default canonical device timestamp stays null; keep local timestamp and warnings. Never substitute receive time for an unknown location observation time. |

## Document inconsistencies

- Main location example p.16 uses satellite byte CC with printed CRC 8081; calculated CRC is 7377. Appendix B p.38 uses CF and CRC 8081, which validates.
- Main heartbeat example p.26 declares length 08 but has a 15-byte frame (requires 0A), and its printed CRC 061F does not validate. Appendix B p.38 provides a length 0A heartbeat with valid CRC 0845 and ACK AFD5.
- The heartbeat response table on p.26 repeats login fields; its heartbeat example and appendix establish protocol 13 and matching serial. Do not reproduce the copied table's protocol 01.
- The mileage-on location table pp.12–13 uses satellite byte CF, length 23 and CRC 6190; these values independently validate. Keep it distinct from the inconsistent CC example on p.16.

## Isolation and rollout

Profile selection comes from registration, never vendor name or a permissive packet-length guess. Tenant/assignment resolution remains in the backend; parser output contains no tenant authority. ACK follows fsynced admission. HTTP retries preserve event identity and accepted source timestamps cannot rewind current state.

The current gateway shares connection slots, spool capacity/write lock and forwarding workers across protocols. This change preserves that architecture; it does not claim resource isolation or a higher fleet capacity. Measure mixed traffic and ACK latency before increasing load. Separate gateway instances require their own spool volumes and a deliberate connection-routing/ownership policy; a second listener alone does not isolate resources.

Rollback: disable GT06N registrations first; drain admitted events before rolling back backend profile support. Keep existing profiles and persisted records unchanged. Unknown GT06N firmware/layouts remain unsupported diagnostics, never guessed business events.

## Validation results

Implementation and QA results are recorded below. No production database or existing running application containers were used.

### Reproduce wire QA

Install the locked Node dependencies, build a native gateway, and provide a disposable PostGIS database:

```sh
npm ci --ignore-scripts
cd services/gateway
go build -o ../../.tmp/gt06n-gateway ./cmd/gateway
cd ../..
export DATABASE_TEST_URL='postgres://USER:PASSWORD@127.0.0.1:PORT/DISPOSABLE_DATABASE'
export GATEWAY_TEST_BINARY="$PWD/.tmp/gt06n-gateway"
npm run qa:gt06n
npm test
npm run quality
```

Wire QA is in `tests/gt06n-wire.test.ts` and also runs in CI's PostGIS-backed Node job. Without both environment variables it visibly skips. It binds only localhost, uses ephemeral ports, an isolated schema and a temporary spool, and cleans up its own test data/processes. Never point it at a production database. The Go decoder fixtures are in `services/gateway/internal/protocol/testdata/gt06n.json`; names `invalidLocation` and `invalidHeartbeat` deliberately retain the document's bad examples. Current-time/optional-mileage frames are synthetic and labeled as such; they are not physical-device captures.

### Implementation choices and limits

- GT06N events use parser version `gt06n-1`. Standard/EG02 parser versions and layouts remain unchanged. Unknown or mismatched login profiles cannot be acknowledged or relabeled as another profile.
- `GT06N_UTC_OFFSET_MINUTES` is blank by default and accepts integer offsets from -720 to 840. A blank offset keeps `deviceTimestamp` null, preserves `deviceLocalTimestamp`, and marks `timestampQuality=UNVERIFIED_TIMEZONE`. Such GPS/alarm records remain device-only logs without GPS points/latest position. Login/heartbeat can still associate at receipt time; heartbeats can update ignition/activity.
- A configured offset is recorded with `timestampQuality=CONFIGURED_OFFSET` and `deviceUtcOffsetMinutes`. It must reflect independently confirmed firmware configuration. Updating it requires gateway restart and does not re-decode previously spooled/persisted records. It is intentionally one setting per gateway, not a new per-device timezone subsystem.
- GT06N GPS records carry `historyStatus=NOT_PROVIDED` and a warning. The existing boolean `historical=false` means no established history marker here, not proven live traffic. Source-time assignment and monotonic SQL updates protect against delayed records even without a reupload bit.
- Preserve unknown alarm/language values rather than invent names. The simple alarm ACK in section 5.3.2 has no documented language condition; language-specific address responses remain disabled. Battery/GSM levels and exact payload sizes are checked. No LBS-derived location or mileage units are invented.
- The profile has a minimum 240s idle timeout to avoid racing the documented 180s heartbeat. Login/frame deadlines and connection/spool caps remain in force. This is a conservative server setting, not hardware timing certification.
- Shared gateway capacity remains shared. No new dependencies, database migrations or production services were introduced. QA setup repaired two missing optional dependency entries (`fsevents` and `pg-cloudflare`) in the lockfile so `npm ci` works; pinned application versions were not changed.

### Executed QA

Validated locally on 2026-11-26 (Asia/Kolkata), using the repository's Go 1.27 toolchain in an isolated Docker container and a disposable PostGIS 16/3.5 database. The host is ARM64; PostGIS's published image required amd64 emulation. Existing database containers were untouched.

- `npm run quality` and production `npm run build` passed. The full PostGIS-backed `npm test` run passed 36 tests with no skips, including the wire QA and existing registration/replacement, tenant access, authentication/tickets, ingestion/history, outbox, realtime and template checks.
- Gateway `go vet ./...` and `go test -race ./...` passed. GT06N fuzzing ran 10s with 412,414 inputs and no failures. Shared framing and legacy decoder fuzzing were also run as regression checks.
- Real TCP QA sent split login and coalesced location/alarm/heartbeat frames through the gateway and actual authenticated backend ingestion routes. It stored 15 GT06N logs and 5 GPS points, plus 3 legacy Concox logs on the same listener. One exact timestamped location retransmission deduplicated. CRC-invalid, malformed and wrong-profile packet types remained diagnostics without ACKs or GPS/state effects.
- Confirmed decoded coordinate output: latitude 23.111668333333334, longitude 114.409285; speed 0 km/h, heading 143° in the document location fixture. Synthetic current-time course D400 correctly provided ignition ON; the document's course 148F left location ignition unavailable. PostGIS longitude/latitude axes matched.
- Unknown timezone produced null canonical device time and no GPS points. After explicit UTC offset 0 configuration, source timestamps and optional raw mileage were retained. Delayed GPS did not rewind current position; heartbeat status remained independent.
- During a simulated backend 503 outage, a heartbeat was durably admitted and ACKed. The gateway was SIGKILLed and restarted with the same spool. The queued event committed exactly once with its original event ID/hash. Final spool pending/quarantine counts were both 0; 15 GT06N outbox entries existed.
- Tests verified foreign-tenant log list/detail denial and viewer raw-data redaction. Gateway session tests additionally cover standard/EG02/GT06N profile mismatches, disabled/unknown registrations, duplicate sessions, changed identity, spool-full/no-ACK behavior, corruption limits, partial/final reads and the GT06N idle margin. UI summary tests verify visible timezone/history uncertainty.
- QA setup initially exposed missing Node dependencies/optional lock entries. Those entries were repaired. A first full-suite command incorrectly set `LOG_LEVEL=error`, causing the existing all-log-levels test to fail; rerunning with default logging passed. Application logging behavior was not changed to accommodate the test.

Limits: no physical GT06N tracker/firmware capture or long-running mixed-fleet capacity soak was available. Actual commands, address/SMS flows, device timezone configuration, reconnect deadlines and firmware-specific layouts remain hardware/vendor gates. Template/summary tests and actual backend routes were exercised; an interactive browser click-through was not performed. Realtime outbox persistence was checked by the wire test; Socket.IO delivery is covered by the existing realtime suite, not a claim of physical-device-to-browser delivery here.
