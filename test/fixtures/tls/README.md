# Optional TLS regression fixture

This directory belongs to the test suite. It is not a ULDA runtime dependency
or a required deployment component. The normal root Compose stack runs the
application and PostgreSQL plus one-off setup/migration jobs. The application
image excludes this directory, Nginx and its configuration.

The fixture adds a separate Nginx container to exercise HTTPS/WSS certificate
validation, WebSocket forwarding, edge limits and backup/recovery behind TLS.
`npm run test:deployment` uses this overlay on isolated temporary resources.
It must not target an operator's running stack. The capacity runner uses direct
loopback HTTP/WebSocket and never starts this proxy.

Paths in `compose.yaml` resolve against the root Compose file supplied first:

```sh
docker compose -f compose.yaml -f test/fixtures/tls/compose.yaml config --quiet
```

This check needs the certificate/key variables described in the
[deployment reference](../../../docs/DEPLOYMENT.md#httpswss-proxy) and Compose
2.24.4 or newer. CI generates disposable test certificates; never deploy them as
real identities. A production operator can use their own ingress, load balancer
or TLS proxy. Neither this fixture nor Nginx adds application authorization.
