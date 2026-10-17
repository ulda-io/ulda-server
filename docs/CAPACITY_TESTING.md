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
$env:ULDA_TEST_POSTGRES_IMAGE='ulda/postgres:security-check'
$env:ULDA_LOAD_CLIENTS='100'
$env:ULDA_LOAD_WORKERS='4'
$env:ULDA_LOAD_SECONDS='1800'
$env:ULDA_LOAD_WARMUP='10'
$env:ULDA_LOAD_PROFILE='host'
npm run test:capacity
```

The specified images must already exist locally. Without a database override,
the runner builds a task-specific database image. It resolves image IDs, creates a fresh
uniquely named Compose project, generates separate password files, initializes
least-privilege database roles and migrates a new volume. It never accepts a target
server/database URL and never reads the operator's `.env`. The existing running
application is not replaced. Cleanup verifies project labels before removing
only test containers, networks and volumes; generated password files are removed.
Test summaries remain in ignored `.local/ulda-capacity-*` directories.

## Profiles and limits

To test a locally prepared SDK candidate instead of the pinned published
consumer, explicitly set `ULDA_TEST_SDK_TARBALL` to its local `.tgz` path before
running the command above. The runner installs it with lifecycle scripts disabled
in a new isolated consumer. Its report records archive SHA-256, installed package
version, consumer lock hash and the fact that it is an unpublished candidate.
No source-directory substitution occurs. Without this option, the pinned registry
consumer remains the default. The same-version label alone does not identify a
candidate; use the archive hash. This option never publishes a package.

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

## Read batch sizing

`node scripts/check-batch-sizing.mjs` compares 16/32/64/100/200-entry protocol variants in
temporary SDK copies and a single read-only mounted compiled server module.
It never edits production batch constants. Set `ULDA_TEST_IMAGE`,
`ULDA_TEST_POSTGRES_IMAGE` and `ULDA_TEST_SDK_TARBALL` to explicit local artifacts,
and build the repository first. Run it separately from other load measurements.

The runner creates a labeled Docker network, temporary PostgreSQL volume and
one application container at a time. It tests one client with 1,000 small contents,
100 clients with 200 small contents each, and 100 clients with 200 larger contents
each. Nominal JSON sizes are 1 KiB and 32 KiB. ID sets are disjoint across clients.
Fixtures clone synthetic encrypted records to isolate read batching costs; this
is not a key-generation or write-throughput benchmark. Client operations use the
public SDK entry and verify all returned JSON. Database seeding uses test-only
internal crypto helpers; no real user data is used.

Each size runs three times in rotated order. Reports contain complete open time,
content-read/decrypt time, limit responses, request counts, errors and generator
memory. Server cgroup memory peak is cumulative since that variant's container
started. `MEASURED` means the experiment finished, not that every candidate passed:
inspect per-run errors and safe error codes. Any recommendation must account for
concurrent admission pressure and byte bounds, not just the fastest single read.
Results are host/workload specific; packet counts are not an absolute optimum.

The current server reserves the worst-case payload size for every ID before a
read. Under concurrent load, `LIMIT` can therefore mean temporary budget pressure,
even when actual records are small. The SDK splits rejected batches, but a
single-ID read can still be rejected when that budget is exhausted. Compare
successful complete opens: lower latency among only the surviving clients does
not establish that a larger batch performs better.

For a separate diagnosis of conservative read reservations, append
`--diagnose-read-budget`. This runs only batch 64 once per profile, with an
explicit 4 GiB logical read budget in the isolated server while retaining the
1 GiB container cap. It is not a production recommendation or a passing sizing
result. Comparing it with the default-budget experiment can identify reservation
pressure; a safe fix still needs bounded memory accounting and overload behavior.
