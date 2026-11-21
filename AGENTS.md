# Agent Gateway — AGENTS.md

Fork of `hucklenanny/gateway/`. Design and build plan: `docs/plan.md`.

## Invariants

- Agent-agnostic: no domain knowledge, no agent names in code. All personality lives in
  `config/gateway.yaml`.
- Secrets referenced by env name, never stored in config.
- Config validated with zod `.strict()` at boot; invalid config exits non-zero with the JSON path.
- One socket per token. Two containers sharing a token duplicate every event.
- Interactions: Ed25519 over raw bytes; defer within 3s; PATCH `@original` for the follow-up.
- `GET /config` returns the loaded config redacted.

## Conventions

- Bun + TypeScript, ESM, `moduleResolution: Bundler`.
- Co-located `*.test.ts`. Tests must be env-free except the e2e/nanny-compat black-box tests.
- `bun run typecheck` before commit.
