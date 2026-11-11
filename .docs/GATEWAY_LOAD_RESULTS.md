# Gateway load and recovery results

Tested locally on 2026-11-11 with Docker Desktop Linux containers: 12 available CPUs and approximately 3.66 GiB VM memory. The existing local stack was idle; test traffic used a separate internal network and disposable database/spool. These are short workload measurements, not a sustained fleet-size guarantee.

## Resource envelope

| Component | CPU quota | Memory limit |
| --- | --- | --- |
| Go gateway and log runner | 0.5 core | 256 MiB |
| Backend | 0.5 core | 384 MiB |
| PostGIS | 0.5 core | 384 MiB |
| Realtime | 0.25 core | 128 MiB |
| Sender | 0.25 core | 192 MiB |

Total runtime ceiling: 2 CPU cores and 1,344 MiB RAM, with no additional swap allowance. Gateway uses GOMAXPROCS=1, a 160 MiB Go memory target and a 64 MiB test spool. Application logging remains enabled at trace level, with rotated file sinks. No test ports are published. Builds are serialized and are separate from runtime quotas.

## Measured packet admission

The workload uses the captured standard-heartbeat status and documented login/location/voltage/alarm layouts. Test identifiers, UTC and serials are synthetic. One burst sends four coalesced packets per device; the second ACK is a barrier confirming preceding no-response packets were admitted. Rates below exclude login setup and describe payload admission into the durable spool, not database throughput.

| Run | Concurrent devices | Payload packets | Admission packets/s | Additional final DB drain | Maximum four-packet batch ACK wait |
| --- | --- | --- | --- | --- | --- |
| 50-device recovery workload | 1 | 12 | 33.5 | 0.54s | 0.16s |
| Same workload | 10 | 120 | 47.5 | 6.62s | 0.87s |
| Same workload | 50 | 600 | 32.5 | 19.91s | 9.55s |
| Separate capacity probe | 128 | 512 | 40.8 | 25.28s | 12.49s |
| Same capacity probe | 256 | Incomplete ACK phase | Overload | Retained for audit | ACK timeout |

The 128-device phase's maximum heartbeat ACK wait was 3.22s. The four-packet batch wait includes the alarm ACK and is not an individual heartbeat measurement. The completed 50/128-device bursts corresponded to roughly 14?16 payload packets/s when the final database drain is included. The nominal 256 connection cap is not a guarantee of acceptable packet latency at that concurrency.

At 256 connections, four extra connections were explicitly rejected by the cap. All 2,225 attempted frames were accounted for after stopping the gateway: 1,026 database events plus 1,199 retained spool events, with zero conflicting identities and zero missing confirmed admissions. The 256-device run failed its latency criterion; stored/pending data is not evidence that the load was healthy. No container was OOM-killed. Sampled gateway memory peaked at 28.88 MiB in that probe; the limit remained 256 MiB. Samples are not an absolute memory-peak measurement.

## End-to-end and recovery checks

- The 50-device workload persisted all 1,613 expected events and 746 GPS points. It passed decoded-field/axis checks, REST reads, backend pause and gateway SIGKILL/restart. Its final durable audit had zero missing or pending packets. This burst-oriented run still had a notification backlog at the data-drain snapshot.
- A follow-up 10-device workload persisted all 359 events/164 points and delivered 359 notifications. The notification backlog drained in another 12.04s after data persistence; final spool and outbox counts were zero. Stored raw hashes, decoded values and PostGIS axes matched the sender manifest.
- A small CI-shaped run admitted 62 frames, persisted 61 unique events/26 GPS points, and explicitly classified one identical timestamped GPS retransmission as a duplicate. It passed outage/restart recovery, raw-byte/hash checks, REST checks and notification drain. All 62 admissions were accounted for, including the known duplicate, with zero missing, pending or quarantined records.
- Regression coverage includes final bytes returned with EOF/reset, split/coalesced reads, incomplete frames, no ACK on failed admission, terminal corruption diagnostics, concurrent queue recovery, single spool ownership, failed quarantine moves, retry identity and per-device ordering/fairness.
- PostgreSQL integration now tests pagination with several rows inside the same millisecond. Cursor timestamps preserve database microseconds; JavaScript Date rounding no longer skips those rows. The wire harness also enumerates all REST pages and reconciles their IDs.

Notifications are refresh hints, not a packet archive or a browser receipt guarantee. REST and PostgreSQL remain authoritative. GPS retransmissions can deliberately deduplicate; repeated untimestamped heartbeat observations are preserved. The sender/auditor distinguishes those policies rather than labelling every socket write as a new database event.

## Reproduce

```bash
npm run stress:gateway
# Small complete flow/recovery regression:
LOAD_DEVICES=2 LOAD_ROUNDS=1 npm run stress:gateway
# Capacity probe; a timeout is a measured overload outcome, not a passing result:
LOAD_DEVICES=256 LOAD_ROUNDS=1 npm run stress:gateway
```

In PowerShell, set `$env:LOAD_DEVICES` and `$env:LOAD_ROUNDS` before invoking the npm command. Default workload is 50 devices and three rounds. The harness enforces a 15-second application ACK deadline from transmission; that is a test setting, not verified firmware behavior. Reports, manifests, container quotas/states, sampled stats and stopped-spool evidence are under ignored `.tmp/gateway-load/`. Test resources carry an ownership label and are cleaned up after each run.

Key artifacts from this session:

- `fleet-load-2193ad7bfd`: 50-device persistence/recovery run.
- `fleet-load-47370863fd`: capacity probe, including the 256-device timeout and durable audit.
- `fleet-load-21ba82693b`: full notification-drain follow-up.
- `fleet-load-b30d64f32b`: explicit wire-retransmission classification regression.
- `fleet-load-c32d00e997`: complete REST-pagination, deduplication and recovery regression (62 admitted frames, 61 unique stored events, zero pending notifications).
- `fleet-load-8cfcdc9882`: post-cleanup regression using the test-only Docker target; the same 62 admissions/61 stored events passed all checks.

Current checks also include TypeScript, ESLint/Prettier, 33 Node tests with real PostGIS, Go vet/race and decoder/framing fuzzing. The completed tree passed these checks and 12 rebuilt-container smoke checks; all regular services started successfully. Benchmark helpers are excluded from the default backend image and added only in its explicit load-test target.

## Limits of the result

A 24-hour soak, every filesystem crash boundary, actual disk-power loss, full 1 GiB spool depth and physical-tracker location/alarm/ACK-timeout validation were not exercised. The safe sustained device count depends on reporting frequency, packet mix, disk and verified firmware deadlines. Do not deploy at the demonstrated overload boundary. Network data never received, unauthenticated/rejected traffic, expired retention and destroyed host storage are outside the admitted-packet durability claim.

## Final cleanup review

Removed benchmark helpers from the default backend image; they are available only through its explicit load-test target. Removed the unused queue peek API from runtime code, simplified duplicated scheduler-test setup, and reverted the remaining EC2-related Git-attribute change. The temporary PostGIS test container and Go test-cache volume were removed after verification. Normal application containers remain running. Retained reports are development artifacts ignored by Git; uploaded instance logs were not removed.

## Final regression rerun

A fresh isolated PostgreSQL run passed all 33 application tests with no skips; TypeScript, lint and formatting checks passed. Existing login and protected vehicle/log pages served correctly, and all 35 checked script/style/module requests succeeded through the running proxy. Production-image inspection confirmed that stress helpers are absent. The current wire/recovery replay (`fleet-load-9a7971f257`) accounted for 62 admissions as 61 unique stored events plus one intentional retransmission, with full REST pagination, zero missing/pending packets and zero pending notifications. No application source changes were needed during this rerun. Browser-host access was unavailable, so a visual interactive click-through was not performed.
