# Documentation

## Use and operate the server

| Document | Contents |
| --- | --- |
| [Project README](../README.md) | Local Docker setup and client SDK example |
| [Manifest](../MANIFEST.md) | Architecture, pipelines and guarantees |
| [SDK protocol](SDK_PROTOCOL.md) | Exact events, binary fields, ACKs and errors |
| [Socket boundaries](SOCKET_BOUNDARIES.md) | Ordering, failure handling and reservation ownership |
| [Configuration](CONFIGURATION.md) | Environment variables and configuration boundaries |
| [Deployment](DEPLOYMENT.md) | Roles, secrets, TLS, migration, backup, restore and updates |
| [Admission limits](ADMISSION_LIMITS.md) | Connections, queues, subscriptions and byte budgets |
| [Operations](OPERATIONS.md) | Readiness, SQL timeouts and graceful shutdown |
| [Logging](LOGGING.md) | Safe diagnostic codes |
| [Container policy](CONTAINER_SECURITY.md) | Image contents and runtime restrictions |
| [Security](../SECURITY.md) | Trust model, limitations and private reporting |
| [License](../LICENSE.md) | Community and commercial terms |
| [Third-party notices](../THIRD_PARTY_NOTICES.md) | Separate dependency licenses |

## Develop and verify

- [Testing](TESTING.md): prerequisites, commands, isolation and validation scope.
- [Source walkthrough](../SERVER_WALKTHROUGH.md).
- [Published SDK integration](PUBLISHED_SDK_TESTS.md): isolated tests using the
  public client package and disposable PostgreSQL.
- [Deployment drill](DEPLOYMENT.md#reproduce-the-local-deployment-drill): roles,
  TLS, backup/restore and SDK recovery.
- [Legacy protocol](LEGACY_PROTOCOL.md): explicitly selected compatibility test
  endpoint, not the production SDK endpoint.
- [Change log](CHANGELOG.md).
