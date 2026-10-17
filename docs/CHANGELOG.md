# Changelog

## 1.0.0

- Bounded FIFO admission for concurrent reads and mutation validation without
  increasing byte limits; cancellation, shutdown cleanup and distinct temporary
  `not_ready` rejection prevent read-splitting storms under budget contention.
- PostgreSQL checks ordinary Read's aggregate byte bound in the same query before
  returning any BYTEA, avoiding oversized result transfers followed by a size retry.
- Reproducible batch-size comparisons now measure synchronized Refresh as well
  as Connect, with a separate large-payload regression.

- Large encrypted resource transfers, bounded read fragments and staged mutation
  uploads with one atomic commit; compatible ordinary SDK CRUD remains unchanged.
- Fragmented Changed delivery for capable clients; legacy recipients are closed
  when a committed notification exceeds their supported framing.
- Configurable staging/resource/deadline budgets and default per-socket
  subscriptions/total Router capacity of 32768 for larger client catalogs.

- Application-only Docker Hub releases, with separately maintained databases
  and proxies; test-fixture CVE reports are advisory and remain visible.
- External-PostgreSQL Compose recipe and required published-SDK smoke before
  publication, using the same application image and restricted database roles.
- Storage adapter contract and deployment maintenance boundaries.

- GitHub checks and a protected Docker Hub release workflow using tested image
  archives, full vulnerability reports, component inventories and registry checks.
- Configurable connection-budget guidance distinguishing core verification from
  complete SDK/database throughput.

- Single-process Socket.IO server compatible with ulda-auth@1.0.1.
- Opaque PostgreSQL resources, atomic mutation batches, directed witness checks
  and connection-scoped change subscriptions.
- Bounded admission, safe diagnostics, database role separation and container
  deployment with migration, TLS and recovery instructions.
- Unit, PostgreSQL, published SDK and container regression suites.
- Digest-pinned Alpine runtime with OS updates, preserved package metadata and
  setuid/setgid permissions removed from system executables.
- Integration and deployment checks can reuse one reviewed local image ID.
- Isolated capacity runner with published SDK clients, uncapped sequential
  updates, latency/resource measurements and final persisted-state verification.
- Separate digest-pinned PostgreSQL 18 bookworm and stable slim Nginx builds;
  updated OS packages and rebuilt gosu, without unused JIT/XML/image tooling.
- Auxiliary image checks and an optional same-major database upgrade drill,
  followed by SDK verification and backup restoration into a separate volume.
