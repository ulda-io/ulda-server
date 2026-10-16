# Capacity measurement

The runner measures confirmed encrypted SDK updates against one server process
and one PostgreSQL database. Each connection owns one content resource and sends
the next update only after the previous ACK. There is no target updates/second,
unbounded request queue, concurrent update to the same chain, or retry of a failed
write. This is a closed-loop throughput experiment, not a fixed arrival-rate SLA.

## Run

Install the repository and `test/consumer` lockfiles, build and review a local
image, then run from the repository root with Linux Docker available:

```powershell
$env:ULDA_TEST_IMAGE='ulda/server:security-check'
$env:ULDA_LOAD_CLIENTS='100'
$env:ULDA_LOAD_WORKERS='4'
$env:ULDA_LOAD_SECONDS='1800'
$env:ULDA_LOAD_WARMUP='10'
$env:ULDA_LOAD_PROFILE='host'
npm run test:capacity
```

The image must already exist locally. The runner resolves its ID, creates a fresh
uniquely named Compose project, generates separate password files, initializes
least-privilege database roles and migrates a new volume. It never accepts a target
server/database URL and never reads the operator's `.env`. The existing running
application is not replaced. Cleanup verifies project labels before removing
only test containers, networks and volumes; generated password files are removed.
Test summaries remain in ignored `.local/ulda-capacity-*` directories.

## Profiles and limits

`host` removes the CPU quotas only for the test server and test database. Both
retain the Compose 1 GiB memory limits, single application writer, connection,
queue, command-rate and output safeguards. The Docker VM's CPU/RAM allocation
and competing host processes still apply. `compose` preserves one CPU per service.
No production settings are changed by either profile.

The public `ulda-auth@1.0.1` consumer uses its default cryptographic settings,
mode X and synthetic JSON of approximately 1 KiB. Password derivation and resource
creation occur before measurement. Registration performance, fanout to many
readers, contention on one resource, larger payloads and TLS/WAN overhead require
separate scenarios. This runner uses loopback HTTP/WebSocket without the TLS proxy.

`ULDA_LOAD_CLIENTS` accepts 1–100; `ULDA_LOAD_WORKERS` accepts 1–12 and cannot exceed
the client count. Total connections stay fixed when workers change. Duration is
5–3600 seconds and warmup is 0–60 seconds. Use short 1/4/8-worker comparisons before
a long run: a saturated generator can otherwise look like a server limit. Generator
workers are separate client processes, not extra application servers.

## Interpret the result

The JSON report records attempted/confirmed/failed operations, confirmed updates
per second, latency p50/p95/p99, transport ACK latency, generator CPU/event-loop
delay/RSS, server/database Docker statistics, sampled PostgreSQL wait events,
image IDs and SDK lockfile digest.
Latency histograms have one-millisecond buckets and explicit overflow above 60 s.
Requests completing after the measurement deadline are reported separately, and
the throughput denominator includes final draining time. Warmup, setup and final
verification do not count as measured updates. Metrics collection errors are visible.

Any failed or uncertain update stops the workload; no mutation is replayed.
After measurement, every client rereads its content and checks its final sequence.
The database row count and absence of author-echo Changed messages are checked.
Successful measurement requires no failed writes/asynchronous errors, successful
final-state checks, and cleanup. It does not by itself require p95 below a release
threshold: compare that threshold explicitly in the acceptance report.

A result is the observed ceiling of this client/server/database/host setup at
100 connections. It is not an absolute server maximum or a guarantee for other
hardware. At saturation a closed-loop generator slows down with responses;
it does not establish behavior under a larger externally imposed arrival rate.
