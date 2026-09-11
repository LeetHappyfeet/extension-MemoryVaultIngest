# MemoryVaultIngest

**MemoryVaultIngest is a SillyTavern extension that connects active conversations to AIOS.** It synchronizes the SillyTavern conversation, character identity, and source message history with AIOS, then retrieves the current AIOS **HUD** before generation and injects it into the SillyTavern prompt. This lets SillyTavern use AIOS-managed persistent memory, knowledge, world state, relationships, recent events, and other runtime context without duplicating that logic inside the extension. SillyTavern remains the chat and generation interface; MemoryVaultIngest is the bridge to AIOS.

> **Status:** Experimental and under active development.
>
> **Requires:** SillyTavern and a reachable AIOS API.

## Install

### Install through SillyTavern

1. Open **SillyTavern**.
2. Open **Extensions**.
3. Select **Install Extension**.
4. Enter:

```text
https://github.com/LeetHappyfeet/extension-MemoryVaultIngest
```

5. Install the extension.
6. Reload SillyTavern.

MemoryVaultIngest should now appear in the SillyTavern extension settings.

### Manual installation

For development, clone the repository into SillyTavern's third-party extension directory.

From the SillyTavern installation directory:

```bash
cd public/scripts/extensions/third-party
git clone https://github.com/LeetHappyfeet/extension-MemoryVaultIngest.git MemoryVaultIngest
```

The resulting directory should look like:

```text
SillyTavern/
└── public/
    └── scripts/
        └── extensions/
            └── third-party/
                └── MemoryVaultIngest/
                    ├── index.js
                    ├── manifest.json
                    └── ...
```

On Windows, a typical installation path is:

```text
C:\SillyTavern\public\scripts\extensions\third-party\MemoryVaultIngest
```

Restart SillyTavern or perform a hard browser refresh after installing or updating the extension.

## Configure

Open **MemoryVault Ingest** in the SillyTavern extension settings.

Set **AIOS API Root** to the address of the AIOS API.

For AIOS running on the same machine:

```text
http://127.0.0.1:8000
```

For AIOS running on another machine on the local network:

```text
http://<AIOS-IP>:8000
```

For example:

```text
http://192.168.1.50:8000
```

The extension will test the connection and display the current AIOS connection state.

The default settings are suitable for initial use. Additional controls are available for HUD token budget, recent-event limits, HUD preparation timing, generation wait budget, retries, cached-HUD use, transcript reconciliation, prompt placement, `<aios_hud>` wrapping, and HUD console logging.

## Run

Once MemoryVaultIngest is enabled and connected to AIOS, use SillyTavern normally.

Open a character and start or load a conversation. MemoryVaultIngest automatically connects the conversation to AIOS:

```text
SillyTavern conversation
        ↓
AIOS session
        ↓
conversation ingestion
        ↓
character runtime
        ↓
AIOS HUD
        ↓
SillyTavern prompt
        ↓
LLM generation
```

Existing messages can be reconciled with AIOS when a conversation is opened. New user and character messages are synchronized as the conversation continues.

Before generation, MemoryVaultIngest requests the HUD corresponding to the current conversation state and injects the returned HUD into the SillyTavern prompt.

There is no separate MemoryVaultIngest process to launch.

## Live AIOS path

The normal live request path is:

```text
POST /session
        ↓
POST /ingest
        ↓
POST /character/{character_id}/activate
        ↓
POST /instance/{instance_id}/hud?through_node_id=<node_id>
        ↓
HUD prompt injection
```

`POST /instance/{instance_id}/hud` is the canonical AIOS read path used for live generation.

MemoryVaultIngest is intentionally a thin client. SillyTavern owns the conversation interface and generation workflow. AIOS owns persistent memory, semantic state, character and world state, timelines, provenance, retrieval, and HUD assembly.

## Conversation identity

MemoryVaultIngest supplies a stable external identity for each SillyTavern conversation:

```text
chat:<chatId>
group:<groupId>
```

This allows the same SillyTavern conversation to reconnect to its AIOS session after a browser reload or extension restart.

Individual messages also carry their SillyTavern source message identity so repeated text, edits, and alternate swipes can remain distinguishable in AIOS history.

## Failure behavior

MemoryVaultIngest is designed to fail open.

If AIOS is unavailable or cannot return a suitable HUD within the configured generation window, SillyTavern can continue generating without AIOS context rather than hanging indefinitely.

The extension does not fall back to obsolete AIOS memory or frame endpoints to construct a substitute HUD.

## Diagnostics

MemoryVaultIngest reports bridge activity in the browser console. Typical states include:

```text
DISCONNECTED
SESSION_RESOLVED
SYNCING
RUNTIME_ACTIVE
HUD_PREPARING
READY
DEGRADED
```

Diagnostics can also include AIOS session IDs, runtime instance IDs, source node IDs, HUD freshness, request failures, retry behavior, cache activity, and the returned HUD prompt when HUD logging is enabled.

## Update

If MemoryVaultIngest was installed through SillyTavern's extension manager, use SillyTavern's normal extension update controls.

For a manual Git installation:

```bash
cd public/scripts/extensions/third-party/MemoryVaultIngest
git pull
```

Reload SillyTavern afterward. A hard browser refresh is recommended after JavaScript changes.

## Current scope

Single-character SillyTavern conversations are currently the best-tested path.

Group conversation identity and metadata are supported, but richer multi-character behavior depends on the corresponding AIOS runtime and group semantics.
