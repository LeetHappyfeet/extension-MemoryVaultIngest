# MemoryVault Ingest

SillyTavern extension that bridges chat roleplay to AIOS over FastAPI.

## What it does

- Creates an AIOS session for the active SillyTavern character/user pair.
- Sends rendered user and character messages to `POST /ingest`.
- Activates the AIOS character runtime with `POST /character/{character_id}/activate` when available.
- Fetches AIOS's deterministic roleplay/HUD prompt from `GET /instance/{instance_id}/frame/text` during SillyTavern prompt generation.
- Falls back to the legacy `GET /memory` response if runtime activation/frame retrieval is unavailable.
- Injects the returned AIOS text into the SillyTavern prompt with `setExtensionPrompt`.

The extension does not require changes to AIOS. It targets the API currently exposed by the `AIOS-development` branch.

## Configuration

Open SillyTavern's extension settings and configure the AIOS API root. The default is:

`http://192.168.1.217:8000`

Other controls select prompt insertion position/depth, recent-event count, optional `<aios_context>` wrapping, and legacy `/memory` fallback.

## Local installation

The working SillyTavern extension directory is expected to be:

`C:\SillyTavern\public\scripts\extensions\third-party\MemoryVaultIngest`

After updating the repository files in that directory, reload SillyTavern (a hard browser refresh is safest for JavaScript changes).

## AIOS contract

Current calls made by the extension:

- `POST /session`
- `POST /ingest`
- `POST /character/{character_id}/activate`
- `GET /instance/{instance_id}/frame/text?recent_limit=N`
- `GET /memory?...` (fallback only)

For chat ingestion, `character_id` is normalized from the active SillyTavern character name and `viewpoint_id` is set on character-authored messages so AIOS can preserve the character identity pivot separately from transport speaker metadata.


## Session identity and diagnostics

MemoryVaultIngest treats the active AIOS runtime identity as the combination of character, user, and SillyTavern conversation. Switching chats or groups resets the cached AIOS session/runtime instance so separate conversations are not merged accidentally.

Browser-console diagnostics trace SillyTavern message events and each AIOS bridge stage (`session`, `ingest:user`, `activate`, `frame/text`, and `ingest:character`) without logging message bodies.

Single-character chats are the supported path. Group-chat metadata is forwarded, but group speaker identity behavior is not yet considered fully validated.
