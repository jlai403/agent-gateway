# discord-gateway — fork plan

**Status:** design settled 2026-11-19. Implementation not started.
**Forked from:** `/root/development/hucklenanny/gateway/` (2,360 LOC incl. tests; ~640 LOC src).
**Consumers:** `deal-finder-agent` (new), `hucklenanny` (migration later).

---

## 1. What this is

One reusable Discord edge sidecar, run **once per agent**. It owns the WebSocket gateway, the
REST write path, typing, the interactions endpoint, and slash-command registration. It knows
nothing about deals or babies.

Fork rationale: hucklenanny's gateway already has the parts that are tedious to get right —
heartbeat at the server's interval, re-IDENTIFY with exponential backoff, an identity guard so a
replaced socket cannot act, rate-limit-free REST, and a real WS mock (`test/mock-discord.ts`)
plus an e2e test that spawns the actual `src/index.ts` against mock Discord, a stub consumer and
captured REST calls.

---

## 2. Compatibility contract (must not break during the fork)

From `hucklenanny/src/inbound.ts` and `gateway/src/app.ts`:

| Fact | Source |
|---|---|
| gateway → worker `POST /inbound` `{ chatId, speaker, text }`, `Bearer GATEWAY_TOKEN` | `inbound.ts:9-32` |
| `chatId` is `discord:<channelId>`, opaque to the consumer | `gateway/src/app.ts:7` |
| consumer tolerates extra top-level keys (reads only three fields) | `inbound.ts:9-13` |
| worker → gateway `POST /send` `{ chatId, body }`, `Bearer GATEWAY_TOKEN` | `gateway/src/app.ts:31-45` |
| bot authors dropped; non-mentioned messages dropped **unless** an audio attachment / voice flag | `gateway/src/discord/messages.ts` |
| audio downloaded and transcribed to `[voice note] …` before the seam | `gateway/src/stt.ts` |
| typing re-fired every 8 s while a turn runs | `gateway/src/discord/typing.ts` |
| 404/502 are retryable → log only, no channel error | `gateway/src/worker-client.ts:13` |
| JSON log lines shipped via `POST /log` (Bearer, ≤50 lines) | `gateway/src/logShip.ts` |
| intents `GUILDS \| GUILD_MESSAGES \| MESSAGE_CONTENT` = 33281 | `gateway/src/index.ts:12` |
| no public ingress, no interactions route | hucklenanny `AGENTS.md` |

The fork must reproduce **all** of the above from configuration. That is the migration.

---

## 3. Config (`config/gateway.yaml`)

YAML 1.2 via the `yaml` package. Parsed, then validated by zod `.strict()`; invalid config exits
non-zero naming the path. Secrets are referenced by **env name**, never stored.

```yaml
discord:
  tokenEnv: DISCORD_TOKEN
  applicationIdEnv: DISCORD_APPLICATION_ID
  publicKeyEnv: DISCORD_PUBLIC_KEY          # required only when interactions.enabled
  intents: [GUILDS, GUILD_MESSAGE_REACTIONS]

events:
  forward: [MESSAGE_CREATE, MESSAGE_REACTION_ADD, MESSAGE_REACTION_REMOVE]
  channels: []                              # empty = every channel the bot can see

message:
  requireMention: false
  ignoreBots: true
  audio:
    mode: off                               # off | transcribe
    endpointEnv: STT_ENDPOINT
    prefix: "[voice note] "

inbound:
  url: http://dealfinder:8080/discord/events
  authEnv: CONSUMER_TOKEN
  payload: event                            # event | chat
  timeoutMs: 90000
  retry: { attempts: 3, backoffMs: 500 }

interactions:
  enabled: true
  path: /interactions
  prefix: deal                              # custom_id must start with "<prefix>:"
  defer: true

commands:
  - name: prefs
    description: Set deal preferences
    options:
      - { type: 3, name: city, description: Your city, required: false }
  - { name: source, description: Manage feeds }

typing:
  enabled: true
  intervalMs: 8000

logging:
  format: json                              # json | text
  level: info
  shipUrl: null
```

Intent names → bits (reject unknown names at boot):

| Name | Bit | Value |
|---|---|---|
| GUILDS | 0 | 1 |
| GUILD_MEMBERS | 1 | 2 |
| GUILD_MESSAGES | 9 | 512 |
| GUILD_MESSAGE_REACTIONS | 10 | 1024 |
| DIRECT_MESSAGES | 12 | 4096 |
| MESSAGE_CONTENT | 15 | 32768 |

- `deal-finder-agent`: `[GUILDS, GUILD_MESSAGE_REACTIONS]` = 1025.
- `hucklenanny` compat: `[GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT]` = 33281.
- `.env` holds only: `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`,
  `CONSUMER_TOKEN`, `STT_ENDPOINT`, `STT_API_KEY`.

Defaults precedence: built-in defaults ← `config/gateway.yaml` ← a small env allowlist
(`PORT`, `LOG_LEVEL`, `LOG_FORMAT`).

---

## 4. Seam

### Inbound (gateway → consumer)

`POST {inbound.url}`, `Authorization: Bearer {consumer token}`, JSON.

`payload: event` (deal-finder):

```jsonc
{ "type": "MESSAGE_REACTION_ADD",
  "channelId": "…", "guildId": "…",
  "event": { /* raw Discord dispatch data */ } }
```

`payload: chat` (nanny):

```jsonc
{ "type": "MESSAGE_CREATE", "chatId": "discord:…", "speaker": "Dad",
  "text": "…", "attachments": ["audio/ogg"], "event": { /* raw */ } }
```

`chat` is a superset of nanny's three fields, so its `/inbound` handler works unmodified.
Retries per config; a non-2xx after the last attempt logs one `warn` and drops — the gateway
never buffers unboundedly.

### Outbound (consumer → gateway)

All Bearer `CONSUMER_TOKEN`, all return `{ ok: true, … }` or `{ error }`.

| Route | Body | Notes |
|---|---|---|
| `POST /send` | `{ channelId, content, components?, replyTo? }` → `{ messageId }` | also accepts legacy `{ chatId, body }` |
| `PATCH /messages/:channelId/:messageId` | `{ content, components? }` | used for the live digest line |
| `POST /react` | `{ channelId, messageId, emoji }` | 👀 acknowledgement |
| `POST /typing` | `{ channelId }` | one-shot |
| `POST /work` | `{ channelId, requestId }` | starts a typing ticker |
| `POST /done` | `{ requestId }` | stops it; auto-stops after `maxMs` (90 s) |
| `GET /health` | — | `{ ok, version, socket, intents, consumer, subscriptions? }` |
| `GET /config` | — | loaded config, secrets redacted |

Typing scopes are refcounted per channel: several concurrent `work` ids keep one ticker alive.

---

## 5. Interactions

`POST {interactions.path}`:

1. Verify Ed25519 using `discord.publicKeyEnv`, over `timestamp + raw body`, rejecting a timestamp
   older than 5 minutes. Use **raw bytes**, not a re-serialised JSON body.
2. `type: 1` PING → `{ type: 1 }`.
3. Otherwise require `custom_id.startsWith(prefix + ":")`; reject 400 on mismatch.
4. If `interactions.defer`: respond `{ type: 5 }` (channel message) or `{ type: 6 }`
   (deferred component update) immediately, then forward to the consumer.
   If a consumer answers within `deferWindowMs` (default 1500), proxy its body verbatim instead.
5. Consumer returns `{ content, components?, embeds?, ephemeral? }`; the gateway
   `PATCH /webhooks/{applicationId}/{interaction.token}/messages/@original`.
6. Consumer `> 15 min` or a non-2xx → log and leave the deferred message to expire.

Handled types: `APPLICATION_COMMAND (2)`, `MESSAGE_COMPONENT (3)`, `MODAL_SUBMIT (5)`.

`provision.ts` keeps the registered command set equal to `config.commands`; the gateway never
registers commands at runtime.

---

## 6. Provisioning (`scripts/provision.ts`)

```
bun run provision check   # exits 1 on drift; usable as a deploy gate
bun run provision apply [--dry-run]
bun run provision invite
```

- `check`: `GET /users/@me` (token valid, prints bot name + id), `GET /applications/@me`
  (interactions URL, flags), `GET /applications/{id}/commands`, diff vs config.
- `apply`: `PATCH /applications/@me` with `interactions_endpoint_url` (+ `flags` when a privileged
  intent such as MESSAGE_CONTENT is required), then `PUT /applications/{id}/commands`.
  Idempotent upsert; `--dry-run` prints the mutations.
- `invite`: builds the OAuth2 URL from named scopes/permissions —
  `bot applications.commands`, permissions `VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS |
  READ_MESSAGE_HISTORY | ADD_REACTIONS` = **85056**, optional `guild_id`.

**Not scriptable:** creating the application/bot. One portal visit yields client id + token.

Tunnel (locally managed): `cloudflared tunnel route dns <tunnel> deals.jlai.ca`; dashboard-managed:
the script prints the ingress stanza for `PUBLIC_URL` → `http://<container>:<port>`.

---

## 7. File-by-file delta from `hucklenanny/gateway/`

| File | Action |
|---|---|
| `package.json` | rename `discord-gateway`; add `yaml`, `zod`; scripts `provision`, `verify:nanny` |
| `src/index.ts` | replace `requireEnv` wiring with the config loader; intents from config; keep `waitForBotUser` |
| `src/config.ts` | **new** — YAML load, zod `.strict()`, env-name resolution, `GET /config` redaction |
| `src/app.ts` | split routes: `/health`, `/config`, `/send`, `/messages/:c/:m`, `/react`, `/typing`, `/work`, `/done`, `/interactions` |
| `src/interactions.ts` | **new** — Ed25519 verify, prefix check, defer, forward, follow-up PATCH |
| `src/commands.ts` | **new** — command diff/apply via REST (used by `provision.ts`) |
| `src/discord/gateway.ts` | keep; intents become a constructor argument |
| `src/discord/messages.ts` | generalize: `requireMention`, `ignoreBots`, audio mode; emit `chat`/`event` envelope |
| `src/discord/rest.ts` | add `editMessage`, `addReaction`, `deleteMessage`; honour `retry_after` on 429 and `X-RateLimit-*` |
| `src/discord/typing.ts` | keep; wrap in a refcounted `TypingScopes` manager |
| `src/worker-client.ts` | rename `consumer-client.ts`; payload modes; error policy stays (404/502 retryable) |
| `src/stt.ts` | keep unchanged; called only when `message.audio.mode: transcribe` |
| `src/logShip.ts`, `src/log.ts` | keep; `shipUrl` from config |
| `test/fixtures/nanny.yaml` | **new** — the compat config |
| `test/nanny-compat.test.ts` | **new** — migration proof (see §8) |
| `test/fixtures/dealfinder.yaml`, `test/dealfinder.test.ts` | **new** — reactions + interactions |
| `Dockerfile` | keep shape (Bun base, non-root, HEALTHCHECK on `/health`) |

---

## 8. `nanny-compat` fixture (the migration proof)

Config = `test/fixtures/nanny.yaml`: intents 33281, `requireMention: true`, `audio.mode: transcribe`,
`inbound.payload: chat`, `interactions.enabled: false`, `commands: []`.

Test drives the real `src/index.ts` against `test/mock-discord.ts` + a stub consumer + captured
REST, and asserts:

1. IDENTIFY carries intents `33281`.
2. A non-mentioned message with no audio produces **no** consumer call.
3. A bot-authored message is dropped.
4. A mentioned message posts `{ chatId: "discord:<id>", speaker: "<nick|global_name|username>", text }`
   with the bearer token.
5. A voice note (audio attachment, no mention) is downloaded, transcribed, and posted as
   `[voice note] …` with media never crossing the seam.
6. Typing is fired at identify and again during a slow consumer call.
7. Consumer 404 → no message posted, one warn; consumer 500 → `Something went wrong: …` posted.
8. No `/interactions` route exists (404) when disabled.

Passing this test is the definition of "nanny can move onto the fork".

---

## 9. Ops

- Image `ghcr.io/jlai403/discord-gateway:vX`, one container per agent, one bot token each.
- **One socket per token.** Two containers sharing a token would both identify and duplicate every
  event; document it, and fail `check` if `GET /users/@me` id differs from a recorded value? (No —
  simple guard: log the bot id at startup, and `check` prints it for eyeballing.)
- `HEALTHCHECK` → `GET /health`, which reports socket state (`ready|connecting|backoff`),
  intents, consumer URL host, config hash.
- No database. No persistence. A restart re-identifies.
- Public ingress: only `/interactions`; everything else binds loopback inside the compose network.

---

## 10. Phases

1. **Fork + config** — copy the directory, rename, add `config.ts`, yaml fixture, strip
   nanny-specific env. _Verify:_ existing nanny tests pass unchanged against the compat fixture.
2. **Compat test** — add `nanny-compat.test.ts` per §8. _Verify:_ it passes; mutating
   `requireMention` makes it fail (proves it's testing the knob).
3. **Outbound API** — edit/react/typing scopes/429 handling. _Verify:_ live edit of a posted
   message; 👀 reaction; a forced 429 is retried after `retry_after`.
4. **Interactions + commands** — verify/prefix/defer/follow-up; `provision check|apply|invite`.
   _Verify:_ `/health`'s config hash changes with the file; an unsigned POST is 401; a bad
   timestamp is 401; `provision check` fails on drift and passes after `apply`.
5. **deal-finder integration** — `dealfinder.yaml`, reaction + interaction tests. _Verify:_ react in
   a real channel → consumer sees `MESSAGE_REACTION_ADD` and the digest line is edited.

---

## 11. Risks

- **Ed25519 in Bun.** WebCrypto's Ed25519 support varies; use `node:crypto` `verify` with the raw
  key parsed from hex, and verify over the raw request bytes. A re-serialised body fails.
- **Deferred component updates.** `type: 6` then `PATCH …/@original` edits the source message; a
  `type: 5` response posts a new one. Picking wrong turns a select menu into a second message.
- **Rate limits.** Centralising them is the point of the sidecar; respect `retry_after` and per-route
  buckets, and never retry a `401/403`.
- **Consumer outage.** Bounded retries and drop; no unbounded buffer. Reactions are recoverable via
  a later poll or a manual replay, digests are not — so never let a gateway restart cause a resend.
- **Fork drift.** Once nanny migrates, delete `hucklenanny/gateway/` in the same change; two copies
  of the same 640 lines will otherwise diverge within a month.
