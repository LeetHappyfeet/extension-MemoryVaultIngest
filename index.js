/* MemoryVaultIngest v0.5.0 – prompt interceptor + post-render ingestion */

import {
  eventSource,
  event_types,
  setExtensionPrompt,
  extension_prompt_types,
} from "../../../../script.js";
import { getContext, extension_settings, renderExtensionTemplateAsync } from "../../../extensions.js";

/* ────────────────────────────────────────────────────────────────── */
/* Config                                                             */
/* ────────────────────────────────────────────────────────────────── */
const MODULE_NAME = "MemoryVaultIngest";
const API_ROOT   = "http://192.168.1.217:8000";
const API_SESS   = `${API_ROOT}/session`;
const API_INGEST = `${API_ROOT}/ingest`;
const API_MEMORY = `${API_ROOT}/memory`;

/* Default UI-configurable settings */
const defaultSettings = {
  enabled: true,
  position: extension_prompt_types.IN_PROMPT,  // BEFORE/IN/AFTER allowed
  depth: 1,                                    // attach near latest user msg
  maxRetries: 2,
  retryDelayMs: 500,
  tagWrapper: true,                            // wrap with <memory>…</memory>
};

/* Events */
const LISTEN_SENT        = event_types?.MESSAGE_SENT ?? "message_sent";
const LISTEN_USER        = event_types?.USER_MESSAGE_RENDERED ?? "user_message_rendered";
const LISTEN_AI          = event_types?.MESSAGE_RECEIVED ?? "message_received";
const LISTEN_AI_RENDERED = event_types?.CHARACTER_MESSAGE_RENDERED ?? "character_message_rendered";

let sessionId = null;
let lastInjHash = null; // to avoid duplicate re-injection across runs

/* ────────────────────────────────────────────────────────────────── */
/* Helpers                                                            */
/* ────────────────────────────────────────────────────────────────── */
function normalizeCharId(name) {
  return String(name ?? "").trim().replace(/\s+/g, "_");
}

async function openSession(ctx) {
  if (sessionId) return sessionId;
  try {
    const res = await fetch(API_SESS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: `${ctx.characterId ?? "chat"}-${Date.now()}` }),
    });
    if (!res.ok) throw new Error(await res.text());
    sessionId = (await res.json()).session_id;
    console.debug(`[${MODULE_NAME}] ↯ new session ${sessionId}`);
  } catch (err) {
    console.error(`[${MODULE_NAME}] ❌ session creation failed:`, err);
  }
  return sessionId;
}

async function pushLine(speakerType) {
  const ctx = getContext();
  const msg = [...(ctx.chat ?? [])].reverse().find(m =>
    speakerType === "user" ? (m?.is_user || m?.sender === "user")
                           : !(m?.is_user || m?.sender === "user")
  );
  if (!msg?.mes) {
    console.warn(`[${MODULE_NAME}] ⚠️ No message found for type ${speakerType}`);
    return;
  }
  await openSession(ctx);

  const speakerId   = speakerType === "user" ? ctx.name1 : ctx.name2;
  const recipientId = ctx.groupId ? null : (speakerType === "user" ? ctx.name2 : ctx.name1);

  const payload = {
    session_id: sessionId,
    speaker_id: speakerId,
    speaker_type: speakerType,
    recipient_id: recipientId,
    character_id: normalizeCharId(ctx.name2),
    user_name: ctx.name1,
    text: msg.mes,
  };

  try {
    const res = await fetch(API_INGEST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[${MODULE_NAME}] ❌ ${res.status}:`, await res.text());
    } else {
      const j = await res.json();
      console.debug(`[${MODULE_NAME}] (${speakerType}) ✔ stored:`, j);
    }
  } catch (err) {
    console.error(`[${MODULE_NAME}] ❌ fetch failed:`, err);
  }
}

async function fetchMemoryWithRetry(url, retries, delay) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      console.debug(`[${MODULE_NAME}] 🔍 Attempt ${attempt} fetching memory...`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    } catch (err) {
      console.warn(`[${MODULE_NAME}] ⚠️ Memory fetch failed (attempt ${attempt}):`, err);
      if (attempt <= retries) await new Promise(r => setTimeout(r, delay));
    }
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────── */
/* Injection — runs during combine_prompts                            */
/* ────────────────────────────────────────────────────────────────── */
window[`${MODULE_NAME}_Intercept`] = async function (chat, _maxContext, _abort, type) {
  // SillyTavern calls this during "Running extension interceptors"
  if (type === "quiet") return;

  const s = extension_settings[MODULE_NAME] ?? defaultSettings;
  if (!s.enabled) {
    console.debug(`[${MODULE_NAME}] disabled`);
    return;
  }

  const ctx = getContext();
  if (!ctx?.name2) {
    console.warn(`[${MODULE_NAME}] ⚠️ No character context`);
    return;
  }

  // Use the latest user message as query context
  const lastUserMsg = [...(ctx.chat ?? [])].reverse().find(m => m?.is_user || m?.sender === "user");
  if (!lastUserMsg?.mes) {
    console.debug(`[${MODULE_NAME}] ℹ️ No user message to query memory for`);
    return;
  }

  const normChar = normalizeCharId(ctx.name2);
  const url = `${API_MEMORY}?character=${encodeURIComponent(normalizedCharacterId)}&user=${encodeURIComponent(ctx.name1)}&context=${encodeURIComponent(lastUserMsg.mes)}`;

  const payload = await fetchMemoryWithRetry(url, s.maxRetries ?? 2, s.retryDelayMs ?? 500);
  console.debug(`[${MODULE_NAME}] 🧠 Memory API returned:`, payload);

  if (!payload?.vector_matches?.length) {
    console.debug(`[${MODULE_NAME}] ℹ️ No relevant memory for this context`);
    // You can optionally clear prior injection here if you want ephemeral memory:
    // setExtensionPrompt(MODULE_NAME, "", s.position ?? extension_prompt_types.IN_PROMPT, s.depth ?? 1);
    return;
  }

  const memoryChunks = payload.vector_matches.map(m => m.content).filter(Boolean);
  const joined = memoryChunks.join("\n---\n");
  const formatted = s.tagWrapper ? `<memory>\n${joined}\n</memory>` : joined;

  // Avoid reinjecting identical content (helps with multi-pass flows)
  const curHash = `${normChar}::${lastUserMsg.mes}::${joined.length}`;
  if (curHash === lastInjHash) {
    console.debug(`[${MODULE_NAME}] ↻ Skipping duplicate injection`);
    return;
  }
  lastInjHash = curHash;

  // IMPORTANT: do NOT pass visible=false; let it be visible to the prompt builder.
  setExtensionPrompt(
    MODULE_NAME,
    formatted,
    s.position ?? extension_prompt_types.IN_PROMPT,
    s.depth ?? 1
  );

  console.debug(`[${MODULE_NAME}] ✅ Injected memory (${memoryChunks.length} entries), pos=${s.position}, depth=${s.depth}`);
};

/* ────────────────────────────────────────────────────────────────── */
/* Post-render ingestion (unchanged behavior)                         */
/* ────────────────────────────────────────────────────────────────── */
eventSource.on(LISTEN_SENT, () => {
  console.debug(`[${MODULE_NAME}] 📨 MESSAGE_SENT fired – waiting for USER_MESSAGE_RENDERED...`);
  eventSource.once(LISTEN_USER, async () => {
    console.debug(`[${MODULE_NAME}] ✅ USER_MESSAGE_RENDERED`);
    await pushLine("user");
  });
});

eventSource.on(LISTEN_AI, () => {
  console.debug(`[${MODULE_NAME}] 🤖 MESSAGE_RECEIVED fired – waiting for CHARACTER_MESSAGE_RENDERED...`);
  eventSource.once(LISTEN_AI_RENDERED, async () => {
    console.debug(`[${MODULE_NAME}] ✅ CHARACTER_MESSAGE_RENDERED`);
    await pushLine("character");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* Optional: simple settings panel (enable/pos/depth)                 */
/* ────────────────────────────────────────────────────────────────── */
jQuery(async () => {
  if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
  }
  const html = await renderExtensionTemplateAsync("third-party/Extension-MemoryVaultIngest", "settings");
  const getContainer = () =>
    $(document.getElementById("memoryvaultingest_container") ?? document.getElementById("extensions_settings2"));
  getContainer().append(html);

  const s = extension_settings[MODULE_NAME];

  $("#mvi_enabled").prop("checked", s.enabled).on("change", () => {
    s.enabled = !!$("#mvi_enabled").prop("checked");
  });

  $(`input[name="mvi_position"][value="${s.position}"]`).prop("checked", true);
  $("input[name='mvi_position']").on("change", () => {
    s.position = Number($("input[name='mvi_position']:checked").val());
  });

  $("#mvi_depth").val(s.depth).on("input", () => {
    s.depth = Number($("#mvi_depth").val());
  });

  $("#mvi_tag").prop("checked", s.tagWrapper).on("change", () => {
    s.tagWrapper = !!$("#mvi_tag").prop("checked");
  });

  console.log(`[${MODULE_NAME}] 🟢 Settings panel registered`);
});

console.log(`[${MODULE_NAME}] v0.5.0 loaded (interceptor + post-render ingestion)`);