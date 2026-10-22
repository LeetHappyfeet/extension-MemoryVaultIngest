# MemoryVaultIngest

MemoryVaultIngest connects SillyTavern conversations to AIOS. SillyTavern owns the interface and model generation; AIOS owns persistent memory, identity, knowledge, world state, research, and HUD assembly.

**0.9.0 — experimental API integration branch.** Requires a reachable AIOS installation with the corresponding `AIOS-development` endpoints. This branch does not modify AIOS or the extension's `main` branch.

## Install this branch

Use SillyTavern's extension installer with:

```text
https://github.com/LeetHappyfeet/extension-MemoryVaultIngest
```

Choose `feature/aios-api-integration` as the branch where supported. Alternatively, from an existing extension checkout:

```bash
git fetch origin
git switch --track origin/feature/aios-api-integration
```

For a new manual installation from SillyTavern's third-party extension directory:

```bash
git clone --branch feature/aios-api-integration https://github.com/LeetHappyfeet/extension-MemoryVaultIngest.git MemoryVaultIngest
```

Keep the installed directory named **MemoryVaultIngest** so the extension template resolves correctly. Reload SillyTavern after changing branches or updating.

Configure **AIOS URL** under the extension settings, for example `http://127.0.0.1:8000` or `http://<AIOS-IP>:8000`. The connection indicator checks HTTP availability only; the separate runtime status reports HUD readiness.

## What is new

### Durable session and runtime mapping

Chat metadata stores server-specific session, instance, entity, world, timeline, state-version, identity-version, source-head, and per-message receipt information. Activation is resolved again after reconnect; stored instance IDs are not blindly trusted.

Character IDs preserve the existing normalized-name convention on first connection, then persist in the card's `data.extensions.MemoryVaultIngest.character_id` when SillyTavern supports card writes. Avatar-keyed settings provide a local mapping fallback. The human actor ID is retained for the chat; changing the displayed persona name does not silently create a new human actor.

Existing solo conversations retain `chat:<chatId>` source keys. Group chats use `group:<groupId>:chat:<chatId>:view:<characterId>` source sessions with a shared world. Each responding character reconciles its own transcript perspective, with the actual speaker and viewpoint preserved. Group perspectives include a common per-message evidence correlation key. This avoids cross-character source-slot replacement; full multi-party epistemic behavior still depends on AIOS's downstream implementation.

Ingestion is serialized per perspective. Full receipts distinguish historical replay nodes from the active server source head. Metadata includes the original speaker label, timestamps, generation times, backend, model, message UUID, and selected swipe. Reasoning content is not forwarded.

### Strict live HUD integration

Live context uses only:

```text
POST /instance/{instance_id}/hud?through_node_id=...
```

A generation-ready response must match the active instance and exact source coordinate. Cached HUDs from previous source nodes are not injected. Background preparation is single-flight per coordinate, and stale completions are discarded. Generation waits are bounded and fail open: SillyTavern can continue without AIOS context. Quiet and impersonation generations do not receive this character's HUD. Generation-stop and chat-switch events clear injection and cancel the generation wait.

Settings show the structured HUD and freshness returned by the same request. There are no legacy `/memory` or `/frame` fallbacks. The old option to inject a not-ready HUD has been removed.

### Character identity

Automatic card synchronization fills missing authored facets without replacing existing facets. It imports appearance, personality, example dialogue, and explicit AIOS domain metadata. Scenario and greeting text remain outside durable identity.

Controls also support staging a card without accepting it, explicitly replacing overlapping facets, inspecting identity/candidates/revisions, and accepting or rejecting a candidate. A staged card is not automatically accepted by the next inspection or reconnect. Explicitly import missing facets or replace overlaps when ready. Removing a card field does not delete a previously accepted facet; the backend does not provide full mirror semantics.

### Scoped memory recall

Search memory using a short keyword or phrase. Requests always include the active `instance_id`, include conflicts, and limit results to eight. AIOS currently implements this endpoint with substring matching, not semantic similarity.

The optional **Offer AIOS recall as a model tool** checkbox registers `aios_recall`. This also requires a compatible Chat Completion model/backend and enabled SillyTavern function calling. The tool only searches existing instance knowledge; it does not initiate research or grant knowledge.

### Research dossiers

Open/list dossiers, inspect exposed source excerpts, advance discovery, add follow-up questions, submit one or two selected sections for study, and pause/resume/close where the backend permits.

Advance and study requests persist UUID retry IDs before submission. Timeouts and pending responses retain those IDs across reloads; successful completed operations receive new IDs for subsequent work. Discovery is exposure, not durable knowledge. Study submits selected material to ingestion; it does not claim that knowledge projection has finished.

The existing `<aios_action>{"op":"research","question":"..."}</aios_action>` live character-render path remains supported. Dispatch receipts, including dossier IDs, are retained. Bulk reconciliation does not automatically dispatch historical research requests. The backend remains responsible for validating the current character-authored source node and viewpoint. Native research-tool dispatch is not substituted for that provenance contract.

### Reference resources

Explicitly select a UTF-8 text file, paste text, or import the most recently activated lorebook entries. Imports use `/corpus/document`, deduplicate through AIOS, and remain cold reference material. Files are limited to 4 MB and imported text to two million characters. Nothing is imported automatically, and merely importing lore does not assert world facts or grant character knowledge.

AIOS source profiles/access configuration determine whether an imported resource is available for research. Generic corpus section listing and retry-safe direct consumption are not implemented here; the plugin uses the dossier study workflow for exposed sections. Binary/PDF extraction and automatic Data Bank synchronization are outside this branch.

### Tasks, attention, actions, and diagnostics

Queue an explicit planning, reflection, research, executive, or communication task. Tasks are left to AIOS's scheduler; the plugin does not run them repeatedly. Creation has no backend idempotency contract, so task requests are not automatically retried. After a timeout, check AIOS before submitting again.

Send an explicit attention event through the integration-event gateway. This registers the `memoryvaultingest` integration and submits a deduplicated event/wake. It does not ingest dialogue or create a memory observation, and no callback URL is registered.

Explicit runtime actions refresh state, submit `expected_state_version`, and surface conflicts without automatic retries. `move` commits location state; `inspect`, `use_item`, and `wait` record intent and do not implement arbitrary inspection or item effects.

Diagnostics expose `/agent/runtime/versions` and knowledge atlas health. Optional endpoints unavailable on an older backend report their HTTP errors in the operation result.

## Transcript edits, deletions, and copied chats

Normal edits and swipe selection continue using AIOS's source-slot replacement behavior. Stable message UUIDs are saved with the transcript and used to detect shifted/reordered slots.

**The current API has no general transcript retraction endpoint.** Message deletion, swipe removal, or detected slot reordering blocks further synchronization and HUD injection for that conversation. The block is persisted across reloads. SillyTavern remains usable without AIOS context. Start a new chat to continue AIOS synchronization; this branch does not erase backend history or pretend that missing messages were retracted. Operations that SillyTavern implements by deleting messages, including some regeneration paths, can trigger this block.

A copied chat that inherited another chat's metadata does not silently reconnect to its source session. Use **Connect copied chat independently** under Diagnostics to create a separate session and replay its retained transcript. This is not a historical AIOS state fork. Chat rename events update the stored chat binding while retaining the source-session key.

## API coverage

| Feature | Endpoints |
|---|---|
| Conversation and live state | `/session`, `/ingest`, `/character/{id}/activate`, `/instance/{id}/state`, `/instance/{id}/hud` |
| Identity | `/character/{id}/identity/bootstrap/card`, `/character/{id}/identity`, `/character/{id}/identity/candidate/{candidate_id}/accept`, `/reject` |
| Recall | `/epistemic/search` |
| Research | `/agent/instance/{id}/research`, `/{dossier_id}`, `/advance`, `/question`, `/study`, `/status`, `/tool-request` |
| Resources | `/corpus/document` |
| Task and attention | `/agent/instance/{id}/task`, `/agent/integrations`, `/agent/integrations/{key}/event` |
| Runtime actions | `/instance/{id}/action` |
| Diagnostics | `/healthz`, `/agent/runtime/versions`, `/agent/knowledge-atlas/health` |

Historical forks, automatic world-entity creation, arbitrary world-fact promotion, remote-worker claims, and direct document acquisition remain deferred. They need stronger backend semantics, routing, or retry contracts before automatic client use.

## Development checks

No build step or runtime npm dependencies are required. With Node.js 20 or newer:

```bash
npm run check
npm test
```

Optional HTTP/UI smoke tests use mock SillyTavern modules and a local mock AIOS server:

```bash
npm install --no-save playwright
npx playwright install chromium --only-shell
node scripts/browser-smoke.mjs
```

For a DOM integration run without Chromium:

```bash
npm install --no-save jsdom
MVI_DOM=1 node scripts/browser-smoke.mjs
```

These validate client contracts and controls; they do not replace testing inside a real SillyTavern installation against your running AIOS database. The browser smoke script can save an intermediate screenshot when `MVI_SCREENSHOT` is set.
