# ULDA Server specification

The canonical active specification is the
[SDK wire protocol](docs/SDK_PROTOCOL.md). It defines the binary command arrays,
ACKs, subscriptions, errors and size limits.

The [manifest](MANIFEST.md) describes the implementation guarantees and trust
boundary. The [walkthrough](SERVER_WALKTHROUGH.md) maps those guarantees to source
files. See [configuration](docs/CONFIGURATION.md) and
[deployment](docs/DEPLOYMENT.md) for operation.

The [legacy protocol](docs/LEGACY_PROTOCOL.md) is historical and available only
through explicit test/benchmark configuration. Production uses the SDK endpoint.
