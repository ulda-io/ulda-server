# GitHub Actions and Docker Hub releases

The release publishes **one Linux amd64 ULDA Server application image**. It
contains the built-in PostgreSQL adapter and schema tools, but no database or
proxy service. The npm package remains private; this repository does not publish
an npm server package. Other architectures require their own acceptance.

Operators maintain database/proxy installations, patches and backups. See
[deployment ownership](EXTERNAL_DATABASE.md). The PostgreSQL/Nginx builds in this
repository are disposable integration fixtures, not additional release products.
Their known vulnerabilities remain documented; a server release does not certify
those database/proxy images for production.

## Required checks

`Server CI` runs on branch pushes and pull requests. It checks the publication
tree, complete fetched Git history with Gitleaks, workflow syntax with actionlint,
Node 22/24 on Linux/Windows, production npm advisories, and Linux container tests
using the published compatibility SDK and the pinned 1.1.0 candidate archive. Test credentials belong to disposable databases. No
registry write credentials are available to these jobs.

The image job builds the application and local test fixtures once. Required
integration covers PostgreSQL atomicity, SDK faults, TLS, restricted SQL roles,
restart and backup restoration. A separate smoke uses the application-only
Compose recipe with independently started upstream PostgreSQL, its own database
volume and the published SDK. The database is outside the application project.

Ordinary CI measures 30 seconds of closed-loop load; release CI measures 30
minutes with 100 connections and no target update rate. This is correctness and
capacity acceptance on the runner, not a universal throughput claim. Database
outages, transaction failures or SDK incompatibility still fail required checks.

The candidate identity in `test/consumer-candidate.json` pins the SDK source commit,
version and reviewed npm archive SHA-256. CI checks out that public commit, builds
with its lockfile, verifies the archive hash, then installs it into a clean test
consumer. The required large-catalog test covers 65 public content creations and
a seeded 10,000-content catalog, including two clients, fragmented ciphertext,
Changed, Refresh, deletion and complete staged deletion. Seeding is not a benchmark
of 10,000 sequential `add()` calls. Both short and release capacity tests use this
same archive. The published 1.0.1 consumer remains a separate compatibility check.
See [SDK integration](PUBLISHED_SDK_TESTS.md).

The pinned SDK commit must be reachable in `ulda-io/ulda-auth` before server CI can
run. After npm publication, update the published consumer and its lockfile in a
separate reviewed change; do not silently install an unpinned `latest` version.

Export produces only `server.tar` and a schema-3 `manifest.json`. The manifest
binds the source commit, application archive checksum, image config/rootfs
identity and current acceptance receipts. Fixture identities are recorded as
test context, without database/proxy publication archives. It also records the
immutable upstream database reference and its content identity for the smoke.
It also binds the candidate SDK identity and large-catalog receipt digest. Old
manifests missing this acceptance and extra release images are rejected.

The required security job verifies the application archive and scans that same
artifact with pinned Trivy, retaining all severities and unfixed CVEs. It creates
a CycloneDX inventory. High, Critical and unknown findings, unsupported OS,
missing inventory and malformed evidence fail this job. No `--ignore-unfixed`,
blanket package exception or `continue-on-error` applies to the application gate.

Database/proxy test fixtures have a separate **advisory-only** scan. Its raw
findings are uploaded as `fixture-reports`, not mixed into the application gate.
Only the fixture scanner installation/report steps allow failure; incomplete
inventory produces an explicit workflow warning and never a database security
approval. The retained [PostgreSQL assessment](POSTGRES_SECURITY_REVIEW.md) is
historical evidence, not a way to waive vulnerabilities in the application.

`Required release gate` succeeds only if source, the complete unit matrix,
container acceptance and application image security succeed. A manual run of
`Release to Docker Hub` performs full acceptance but **never publishes**. A
version-tag run can publish only after all checks and approval of the `dockerhub`
environment. Approval does not replace tests.

## Publication

The publish job loads and pushes only the checked application archive. It does
not rebuild or install project dependencies while registry credentials exist.
It verifies the registry manifest/config, pulls the application by digest and
compares its content identity with the checked artifact. After deleting its
isolated registry credentials, it installs the SDK consumer and smoke-tests the
pulled server with a new independently managed PostgreSQL fixture. PostgreSQL is
pulled from upstream by its tested immutable reference, never pushed to ULDA's
registry. Nginx is tested before publication and is not published.

## Configure GitHub and Docker Hub

1. Create an empty repository in the intended GitHub organization. Connect the
   clean checkout and push `main`; branch pushes never publish images.
2. Require `Required release gate` and review of workflow, Dockerfile and release
   changes. Protect version tags from unauthorized creation or movement. Verify
   protection with a failing test before enabling publication.
3. Create **one public Docker Hub repository** for ULDA Server under the chosen
   Docker ID or organization namespace. A Docker Personal account supports public
   repositories without an organization subscription. Choose the name explicitly;
   enable immutable versions where available. Database/proxy repositories and
   Docker Hub Automated Builds are not needed; GitHub Actions performs the build.
4. Create the GitHub environment **`dockerhub`**, require a release reviewer and
   restrict deployments to version tags. Verify environment protections are
   supported by the selected GitHub plan and disable bypass where available.
5. For a personal account, create a PAT with **Repo Read & Write**, without Delete
   or Cloud Sandboxes access. A PAT covers repositories accessible to its account;
   it cannot be restricted to just this repository. Store it only as the
   environment secret `DOCKERHUB_TOKEN`. Never commit it or include it in logs/issues.
   Organizations can use a repository-scoped organization token where supported.

On GitHub Free for organizations, a private repository can run CI but cannot
provide this environment approval setup. Required environment reviewers on Free,
Pro and Team are available for public repositories; private approval requires a
supporting Enterprise plan. Keep publication disabled while staging privately.
For the free release path, explicitly make the reviewed repository public, then
configure and verify branch/tag protection and the `dockerhub` environment before
adding registry write credentials or enabling publication. Do not replace this
approval boundary with an unprotected repository secret.

References: [Docker repository creation](https://docs.docker.com/docker-hub/repos/create/),
[PAT permissions](https://docs.docker.com/security/access-tokens/reference/),
[GitHub environment availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Repository variables:

| Variable | Value |
| --- | --- |
| `ULDA_PUBLISH_REPOSITORY` | Exact approved GitHub `organization/repository` |
| `ULDA_DOCKER_PUBLISH_ENABLED` | Unset until approval, then `true` |

`dockerhub` environment variables:

| Variable | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | Account associated with the token |
| `ULDA_DOCKER_SERVER` | Docker Hub `namespace/server-repository` (personal or organization) |

`ULDA_DOCKER_POSTGRES` and `ULDA_DOCKER_PROXY` are unused and can be removed from
an older configuration. Registry verification expects anonymous read access to
the public server repository.

## Release procedure

1. Complete source/history, image-layer and application CVE review. Review the
   deployment profile and docs. Set the intended version in `package.json` and
   both root-version lockfile fields, and align server version metadata. Update
   the changelog, commit and merge into `main`.
2. Run `Release to Docker Hub` manually on `main`; inspect every required job,
   application inventory/scan and the 30-minute acceptance result. It publishes
   nothing. A later tag run repeats checks against its own exact artifact.
3. Configure protections, enable publication and create/push `v<package-version>`
   on the reviewed commit only when a release is intended.
4. Wait for required checks, inspect the artifact/reports, then approve the
   pending `dockerhub` deployment.
5. Inspect the registry receipt and final SDK smoke. Record the server digest
   in release notes; deploy it using `--no-build` and the migration procedure.

Only explicit numeric version tags are pushed. `latest`/major aliases are not
changed automatically and existing versions are never overwritten. A failed
push or post-publication smoke may leave the image public. Inspect registry
state before recovery; failure does not unpublish it and is not safe to retry
blindly under the same version.

## Local rehearsal

```sh
npm ci --ignore-scripts
npm ci --prefix test/consumer --ignore-scripts
npm run check
npm run test:tools
npm run test:ci
npm run audit:source
node scripts/ci/install-tools.mjs gitleaks actionlint trivy
```

Tool downloads are pinned and checksum-verified. Binaries and private diagnostics
stay under ignored `.local`. The source audit rejects private paths, symlinks,
local dependency bindings and broken relative links; Gitleaks scans history and
the copied publication tree.

Run `node scripts/ci/images.mjs build`. Set `ULDA_TEST_IMAGE`,
`ULDA_TEST_POSTGRES_IMAGE` and `ULDA_TEST_PROXY_IMAGE` to the matching
`ulda-ci/*:candidate` tags. Run integration, deployment and capacity, plus
`node scripts/ci/release-smoke.mjs --candidate`. Then run
`node scripts/ci/images.mjs export`. Export verifies current receipts and images.
Use `ULDA_CI_RELEASE=true` only for a clean checkout and real 1800-second run.
Archive old local three-image output separately before exporting; unexpected
files in `.local/ci-images` are rejected rather than accidentally uploaded.

Set `ULDA_MANIFEST_SHA256` to the exported manifest checksum and run
`node scripts/ci/images.mjs scan` for the required application security gate.
`node scripts/ci/images.mjs scan-fixtures` retains separate infrastructure
findings. `node scripts/ci/release-smoke.mjs --local` rehearses the exported
application with its tested external database, without publication; it cannot
establish registry availability or credentials.

Upload only the application archive, inventories, safe CVE reports and receipts.
Never upload `.local` wholesale, generated passwords/certificates, SQL logs,
database backups or SDK state. CI uses disposable hosted runners without
production secrets; preserve that boundary on any self-hosted runner.
