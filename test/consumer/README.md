# Published SDK consumer

Run `npm ci --prefix test/consumer --ignore-scripts` from the server repository.
This private test package pins `ulda-auth@1.0.1` with a committed lockfile.
`index.mjs` imports only the public SDK exports and checks the installed identity
and location. Never add this consumer to the server runtime dependencies/image.

Run the disposable integration stack with `npm run test:integration`.
See [integration instructions](../../docs/PUBLISHED_SDK_TESTS.md).
