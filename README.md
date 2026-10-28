# Grok → dot event bridge

MCP event bridge with D1 persistence, authenticated owner console, signed event subscriptions, a limited Grok MCP endpoint, and an asynchronous reply outbox.

This is a sanitized source snapshot of the deployed v17 application. The complete tracked source tree is included, with deployment examples substituted for private configuration. Deployment identifiers, production URLs, real test identifiers, credentials, messages, runtime databases, build outputs, and original Git history are excluded. All example hosts and deterministic test credentials are fixtures.

## Development

Requires Node.js 22.13 or later (with node:sqlite support).

```sh
npm ci
node --test tests/*.test.mjs
npm run dev
npm run build
```

The frontend uses React/Vinext and Cloudflare Workers. D1 schema migrations are in `drizzle/`; do not edit already applied migrations. The `DB` binding is required.

## Deployment

The included Sites integration expects ChatGPT Sites hosting and its trusted authenticated-user headers. An ordinary Worker deployment needs an equivalent trusted identity integration; never trust a user-supplied owner header.

1. Register a new Site or use your own existing Site. Replace `YOUR_SITE_PROJECT_ID` in `.openai/hosting.json` and the connection page/prompt with that Site's identifier. Replace `https://bridge.example.com` in source and tests with your own base URL.
2. Provision D1 and apply the checked-in migrations. Preserve the `DB` binding and the `nodejs_compat` and `global_fetch_strictly_public` compatibility flags in `vite.config.ts`.
3. Configure `BRIDGE_OWNER_ID` to the owner's Site-scoped user ID. Keep external ingress and Grok delivery disabled until configuration is complete.
4. Configure runtime secrets through the hosting provider, never in Git. The implementation reads `BRIDGE_MCP_AUTHORIZATION`, `BRIDGE_INGRESS_SECRET`, `BRIDGE_GROK_BEARER_KEY`, and other `BRIDGE_*` settings; inspect their validation in `lib/` before enabling an integration. The MCP authorization value includes its `Bearer ` prefix. The optional owner credential-copy flow must have an explicit expiration (`BRIDGE_HANDOFF_EXPIRES_AT`).
5. Set the Grok channel and approved webhook destination using `BRIDGE_GROK_CHANNEL` and `BRIDGE_GROK_WEBHOOK_URL`, then enable only the required ingress/delivery flags. Never copy a production webhook key into documentation or client code.
6. Use the official Sites `site-workflow.mjs` helper to build/package and publish to your own Site. Pass source credentials through stdin. This GitHub repository does not deploy to or modify the original Site.

## Interfaces and behavior

- `/`: authenticated owner console; `/connect/grok`: protected credential handoff/configuration page.
- `/mcp`: owner tools and MCP event subscriptions.
- `/mcp/grok`: limited Grok submission/result/reply tools using a separate authorization header.
- `lib/bridge-service.mjs`: persistence, ownership checks and dispatch.
- `lib/bridge-protocol.mjs`: strict payload validation, HMAC signatures and callback validation.
- `lib/grok-outbox.mjs`: bounded retries and delivery state; HTTP 200 confirms acceptance, not completion.

Messages are deduplicated by stable ID. A Grok reply receipt terminates the roundtrip with hop=2. External message text is data, never permission to run commands or disclose private information. The owner test endpoint can advance queued deliveries; tests against a real deployment have side effects and need explicit authorization.

## License

Project-authored code is MIT licensed. Bundled third-party notices are retained; see `THIRD_PARTY_NOTICES.md`. Dependency packages retain their own licenses.

