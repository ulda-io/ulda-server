# GitHub Actions and Docker Hub releases

The workflows build and verify Linux **amd64** images for the application,
PostgreSQL and the optional TLS proxy. These are three independent images, not
services embedded in one container. Other architectures need their own acceptance.
The npm package remains private: this repository releases Docker images, not an
npm server package.

## Checks and publication boundary

`Server CI` runs on branch pushes and pull requests. It checks the publication
tree, complete fetched Git history with Gitleaks, workflow syntax with actionlint,
Node 22/24 on Linux/Windows, production npm advisories, and a Linux container stack
using the published SDK. Test credentials are generated for disposable databases.
No registry write credentials are available to these jobs.

The image job builds each image once, tests those image IDs, then exports three
Docker archives with SHA-256 checksums, the source commit and a small acceptance
receipt. Integration covers PostgreSQL atomicity, published SDK faults, TLS,
database privileges, restart and backup restoration. Ordinary CI measures 30
seconds of closed-loop load; the release workflow measures 30 minutes with 100
connections and no target update rate. This is correctness/capacity acceptance
on the runner, not a fixed-arrival-rate SLA or a universal throughput claim.

The security job verifies the archive checksums before scanning the same archives
with a pinned Trivy executable. It retains all severities, including unfixed CVEs,
and creates CycloneDX component inventories. High, Critical and unknown severities,
unsupported OS releases, missing inventories or malformed reports fail the gate.
There are currently **no vulnerability exceptions**. Existing PostgreSQL findings
can therefore keep this job red until individually resolved or a reviewed,
narrowly scoped exception mechanism is introduced. A previous Scout report is
not an exemption from the CI scanner's findings. Do not add `--ignore-unfixed`,
`continue-on-error`, or an unconditional package allowlist to make it green.

`Required release gate` succeeds only if source, the entire unit matrix, container
acceptance and image security all succeeded. A manual run of `Release to Docker
Hub` performs full acceptance but **never publishes**. A stable version tag can
publish only after that complete check workflow succeeds and the `dockerhub`
environment is approved. Approval does not replace the tests.

Only the three checked archives are loaded and pushed. The publish job does not
rebuild images or install project dependencies while registry credentials exist.
It verifies registry manifest/config digests and pulls each image by immutable
digest. After the credential directory is removed, it installs the isolated SDK
consumer and smoke-tests the pulled application and PostgreSQL on a new database.
The proxy is digest-verified after pull; TLS functionality is tested before push.

## Configure the repositories

1. Create an **empty** repository in the intended GitHub organization. Do not
   initialize another README or license. Connect this clean checkout, then push
   `main`; branch pushes do not publish images.
2. Require the `Required release gate` check for `main` and require review of
   workflow, Dockerfile and release-script changes. Protect release tags against
   unauthorized creation or movement. Verify the rules with a deliberately failing
   test before allowing the first release.
3. Create three public Docker Hub repositories in the intended organization.
   Enable immutable version tags where available. Choose names for the server,
   database and proxy explicitly; the workflows do not assume a personal namespace.
4. Create a GitHub environment named **`dockerhub`**, require a release reviewer,
   restrict deployment to version tags, and disable administrator bypass where
   supported. Ensure your GitHub plan supports the selected protection rules.
5. Create a Docker Hub access token with the minimum write permissions for these
   repositories and no delete/admin privileges. Store it only as the environment
   secret `DOCKERHUB_TOKEN`. Do not place it in a file or share it in an issue/log.

Set these repository variables:

| Variable | Value |
| --- | --- |
| `ULDA_PUBLISH_REPOSITORY` | Exact approved `organization/repository` on GitHub |
| `ULDA_DOCKER_PUBLISH_ENABLED` | Leave unset until acceptance is approved; then `true` |

Set these variables on the `dockerhub` environment:

| Variable | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | The account associated with the access token; it can differ from the organization |
| `ULDA_DOCKER_SERVER` | Docker Hub `organization/server-repository` |
| `ULDA_DOCKER_POSTGRES` | Docker Hub `organization/database-repository` |
| `ULDA_DOCKER_PROXY` | Docker Hub `organization/proxy-repository` |

All three image repository values must be different. The publication preflight
expects public repositories so registry verification can use anonymous read access.

## Release procedure

1. Finish source/history and image-layer review, CVE triage, the final deployment
   profile and documentation. Set the intended version in `package.json` and both
   root-version fields of its lockfile; the SDK consumer's version is independent.
   Update the changelog. Commit and merge reviewed changes into `main`.
2. Run `Release to Docker Hub` manually on `main`. Check every required job,
   image inventory, vulnerability report and the 30-minute acceptance result.
   This rehearsal produces no registry publication. Rebuilding later can install
   newer OS updates; the tag run must repeat acceptance on its own exact artifacts.
3. Configure the environment/repository protections above, enable publication,
   and create an exact `v<package-version>` tag on the reviewed commit. Push that
   tag only when a release is intended. Stable numeric versions are required.
4. Wait for all required checks. Review the checked artifact and reports, then
   approve the pending `dockerhub` deployment.
5. Inspect the registry receipts and SDK smoke result. Record the published
   digests in deployment instructions/release notes. Start deployments using these
   digests with `--no-build`, following the documented migration procedure.

Only explicit version tags are published. `latest` and major aliases are not
changed automatically. There is no automatic overwrite of an existing version.
The three registry uploads cannot be one atomic transaction: a failure can leave
some images public. Inspect the receipts and registry before recovery; do not
rerun a partially published version blindly. A failed post-publication smoke
remains a failed workflow and does not unpublish or replace an image.

## Diagnostics and local rehearsal

```sh
npm ci --ignore-scripts
npm ci --prefix test/consumer --ignore-scripts
npm run check
npm run test:tools
npm run test:ci
npm run audit:source
node scripts/ci/install-tools.mjs gitleaks actionlint trivy
```

The tools are downloaded from exact official releases and checked against pinned
SHA-256 values. Their binaries and private diagnostics stay under ignored `.local`.
The publication tree audit accepts only source/documentation/test/build inputs,
rejects symlinks/private filenames/local dependency bindings, and checks relative
Markdown links. Gitleaks scans history and that exact copied publication tree.

For the container sequence, use `node scripts/ci/images.mjs build`, set the three
`ULDA_TEST_*_IMAGE` variables to the `ulda-ci/*:candidate` tags, then run integration,
deployment and capacity checks. Export with `node scripts/ci/images.mjs export`.
Set `ULDA_CI_RELEASE=true` only for a real 1800-second run; export verifies the
current reports and image identities. The scan command requires the exported
manifest's SHA-256 in `ULDA_MANIFEST_SHA256`.

`node scripts/ci/release-smoke.mjs --local` rehearses the final SDK smoke against
the exported local image identities without publishing. Its separate receipt is
explicitly marked local and cannot establish registry availability or permissions.

Upload only the explicit image archives, component reports and sanitized receipts.
Do not upload `.local` wholesale, generated passwords/certificates, database dumps,
SDK state files or raw assertion/SQL logs. The source/history scanner redacts
matches. CI runs on disposable hosted runners without production application
secrets. Keep those properties if moving it to a self-hosted runner.

Related guidance: [Docker test before push](https://docs.docker.com/build/ci/github-actions/test-before-push/),
[GitHub environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[Trivy image scanning](https://trivy.dev/docs/latest/references/configuration/cli/trivy_image/).
