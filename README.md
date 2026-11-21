# Agent Gateway

Reusable Discord edge sidecar. One instance per agent. Owns the WebSocket gateway, REST writes,
typing, the `/interactions` endpoint, and slash-command registration. Agent-agnostic: no domain
knowledge, configured entirely by `config/gateway.yaml`.

Forked from `hucklenanny/gateway/`. The `nanny-compat` test is the migration proof.

## Run

```
GATEWAY_CONFIG=./config/gateway.yaml bun run src/index.ts
```

## Config

See `config/gateway.yaml` (deal-finder) and `test/fixtures/nanny.yaml` (hucklenanny compat).

Secrets are referenced by env var name, never stored in the file.

## Scripts

- `bun test` — full suite (87 tests incl. nanny-compat, outbound, interactions)
- `bun run typecheck` — `tsc --noEmit`
- `bun run provision check|apply [--dry-run]|invite` — Discord app provisioning (see docs/plan.md §6)

## Status

Phase 1 (fork + config-driven wiring) done. Phases 2–5 per `docs/plan.md`.