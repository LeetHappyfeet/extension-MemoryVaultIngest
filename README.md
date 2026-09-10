# MemoryVault Ingest

SillyTavern extension that synchronizes active conversations with AIOS and injects the generation-consistent AIOS HUD into SillyTavern prompts.

## Architecture

MemoryVaultIngest is intentionally a thin bridge. SillyTavern owns the conversation UI and source message slots. AIOS owns durable session identity, the source DAG, character runtime state, semantic memory, retrieval, and HUD assembly.

The live generation path is:

```text
SillyTavern conversation
        ↓
POST /session
        ↓
POST /ingest
        ↓
POST /character/{character_id}/activate
        ↓
POST /instance/{instance_id}/hud?through_node_id=<node_id>
        ↓
generation-consistent HUD
        ↓
SillyTavern prompt injection
```

The extension does not use deprecated `/frame`, `/frame/text`, or `/memory` endpoints as live-generation fallbacks. If an exact HUD is temporarily unavailable, it may use a compatible cached HUD according to plugin settings; otherwise SillyTavern generation proceeds without AIOS injection.

## Conversation identity

The extension supplies a stable external conversation key to AIOS:

```text
chat:<chatId>
group:<groupId>
```

AIOS resolves `(source="SillyTavern", source_session_id=<conversation key>)` to the durable AIOS session, allowing browser reloads and extension restarts to resume the same runtime/source branch.

Each ingested message also includes its SillyTavern `message_id`. This preserves distinct repeated messages in different source slots and lets alternate swipes in the same slot remain related alternatives.

## Transcript reconciliation

When a conversation becomes active, MemoryVaultIngest can reconcile the existing SillyTavern transcript oldest-to-newest before preparing the HUD. Existing messages are sent through `POST /ingest`; AIOS is responsible for deduplication and source-DAG identity.

After reconciliation, normal SillyTavern events keep AIOS current. The bridge observes new user and character messages and also resynchronizes updated/swiped source slots.

## HUD behavior

`POST /instance/{instance_id}/hud` is the only live AIOS read path. The plugin sends:

- `through_node_id`
- `recent_limit`
- `token_budget`
- `wait_ms`

The returned structured frame, rendered HUD text, generation readiness, and freshness metadata are cached together with the active session/runtime/source coordinate. Cached HUD text is reused only when it belongs to the active AIOS conversation/runtime identity.

The generation interceptor remains bounded by a configurable time budget. If AIOS misses that deadline, SillyTavern fails open rather than falling sideways into obsolete AIOS memory endpoints.

## Configuration

Open SillyTavern's extension settings and configure the AIOS API root. The default is:

`http://192.168.1.217:8000`

Controls include prompt insertion position/depth, recent-event limit, HUD token budget, AIOS HUD wait, generation wait budget, generation-ready enforcement, cached-HUD use, transcript reconciliation, optional HUD text console logging, and `<aios_hud>` wrapping.

## Local installation

The working SillyTavern extension directory is expected to be:

`C:\SillyTavern\public\scripts\extensions\third-party\MemoryVaultIngest`

After updating the repository files in that directory, reload SillyTavern. A hard browser refresh is safest for JavaScript changes.

## AIOS contract

Current live calls made by the extension:

- `POST /session`
- `POST /ingest`
- `POST /character/{character_id}/activate`
- `POST /instance/{instance_id}/hud`

For chat ingestion, `character_id` is normalized from the active SillyTavern character name and `viewpoint_id` is set on character-authored messages so AIOS can preserve character identity separately from transport speaker metadata.

## Diagnostics

Browser-console diagnostics report bridge state transitions such as `DISCONNECTED`, `SESSION_RESOLVED`, `SYNCING`, `RUNTIME_ACTIVE`, `HUD_PREPARING`, `READY`, and `DEGRADED`, along with session/runtime IDs, source nodes, HUD freshness, and optional rendered HUD text.

Single-character chats remain the best-validated path. Group-chat metadata and stable group conversation identity are forwarded, but deeper group speaker/runtime behavior still depends on AIOS group semantics.
