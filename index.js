/* MemoryVaultIngest v0.7.2 – source-branch aware HUD preparation */

import {
  eventSource,
  event_types,
  setExtensionPrompt,
  extension_prompt_types,
  saveSettingsDebounced,
} from "../../../../script.js";
import {
  getContext,
  extension_settings,
  renderExtensionTemplateAsync,
} from "../../../extensions.js";

const MODULE_NAME = "MemoryVaultIngest";
const DEFAULT_API_ROOT = "http://192.168.1.217:8000";

const defaultSettings = {
  enabled: true,
  apiRoot: DEFAULT_API_ROOT,
  position: extension_prompt_types.IN_PROMPT,
  depth: 1,
  recentLimit: 12,
  tokenBudget: 4000,
  prepareWaitMs: 1200,
  generationBudgetMs: 900,
  requestTimeoutMs: 1800,
  maxRetries: 1,
  retryDelayMs: 250,
  requireGenerationReady: true,
  useCachedHud: true,
  tagWrapper: true,
  memoryFallback: true,
};

const LISTEN_SENT = event_types?.MESSAGE_SENT ?? "message_sent";
const LISTEN_AI = event_types?.MESSAGE_RECEIVED ?? "message_received";
const LISTEN_AI_RENDERED = event_types?.CHARACTER_MESSAGE_RENDERED ?? "character_message_rendered";

let sessionId = null;
let instanceId = null;
let activeCharacterId = null;
let activeUserName = null;
let activeConversationKey = null;
let lastInjectionKey = null;
let pendingUserIngest = null;
let latestUserNodeId = null;
let latestPreparedNodeId = null;
let cachedHudText = null;
let cachedHudFreshness = null;
let prefetchPromise = null;

function settings() {
  if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
  } else {
    for (const [key, value] of Object.entries(defaultSettings)) {
      if (extension_settings[MODULE_NAME][key] === undefined) {
        extension_settings[MODULE_NAME][key] = value;
      }
    }
  }
  return extension_settings[MODULE_NAME];
}

function normalizeCharId(name) {
  return String(name ?? "").trim().replace(/\s+/g, "_");
}

function apiUrl(path) {
  const root = String(settings().apiRoot || DEFAULT_API_ROOT).replace(/\/+$/, "");
  return `${root}${path}`;
}

function resetRuntimeIdentity() {
  sessionId = null;
  instanceId = null;
  activeCharacterId = null;
  activeUserName = null;
  activeConversationKey = null;
  lastInjectionKey = null;
  pendingUserIngest = null;
  latestUserNodeId = null;
  latestPreparedNodeId = null;
  cachedHudText = null;
  cachedHudFreshness = null;
  prefetchPromise = null;
}

function conversationKey(ctx) {
  if (ctx?.groupId) return `group:${ctx.groupId}`;
  if (ctx?.chatId !== undefined && ctx?.chatId !== null && String(ctx.chatId) !== "") {
    return `chat:${ctx.chatId}`;
  }
  return "chat:unknown";
}

function currentIdentity(ctx) {
  return {
    characterId: normalizeCharId(ctx?.name2),
    userName: String(ctx?.name1 ?? "").trim(),
    conversationKey: conversationKey(ctx),
  };
}

function ensureIdentityMatches(ctx) {
  const { characterId, userName, conversationKey: nextConversationKey } = currentIdentity(ctx);
  const identityChanged =
    (activeCharacterId && activeCharacterId !== characterId) ||
    (activeUserName && activeUserName !== userName) ||
    (activeConversationKey && activeConversationKey !== nextConversationKey);

  if (identityChanged) {
    console.debug(`[${MODULE_NAME}] runtime identity changed; resetting AIOS session`, {
      character_id: characterId,
      user_name: userName,
      conversation: nextConversationKey,
    });
    resetRuntimeIdentity();
  }

  activeCharacterId = characterId;
  activeUserName = userName;
  activeConversationKey = nextConversationKey;
}

function timeoutSignal(timeoutMs, parentSignal = null) {
  const controller = new AbortController();
  const timeout = Math.max(1, Number(timeoutMs || 1));
  const timer = setTimeout(() => controller.abort(new DOMException("AIOS request timed out", "TimeoutError")), timeout);

  const forwardAbort = () => controller.abort(parentSignal?.reason ?? new DOMException("Aborted", "AbortError"));
  if (parentSignal) {
    if (parentSignal.aborted) forwardAbort();
    else parentSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", forwardAbort);
    },
  };
}

async function requestJson(url, options = {}, retries = 0, label = "request", timeoutMs = null) {
  const retryDelay = Number(settings().retryDelayMs ?? 250);
  const requestTimeout = Math.max(50, Number(timeoutMs ?? settings().requestTimeoutMs ?? 1800));
  let lastError = null;
  const method = options?.method ?? "GET";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const bounded = timeoutSignal(requestTimeout, options?.signal ?? null);
    try {
      console.debug(`[${MODULE_NAME}] AIOS -> ${label} (${method}) attempt ${attempt + 1}/${retries + 1}`, url);
      const response = await fetch(url, { ...options, signal: bounded.signal });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`${response.status} ${response.statusText}: ${body}`);
      }
      const json = await response.json();
      console.debug(`[${MODULE_NAME}] AIOS <- ${label} ${response.status}`);
      return json;
    } catch (error) {
      lastError = error;
      const aborted = bounded.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
      console.warn(`[${MODULE_NAME}] AIOS !! ${label} failed:`, error);
      if (aborted) break;
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    } finally {
      bounded.cleanup();
    }
  }

  throw lastError;
}

async function openSession(ctx, options = {}) {
  ensureIdentityMatches(ctx);
  if (sessionId) return sessionId;

  const { characterId, userName, conversationKey: sourceSessionId } = currentIdentity(ctx);
  const payload = {
    topic: `${characterId || "chat"}-${Date.now()}`,
    source: "SillyTavern",
    source_session_id: sourceSessionId,
    meta: {
      character_id: characterId,
      user_name: userName,
      group_id: ctx?.groupId ?? null,
    },
  };

  const json = await requestJson(apiUrl("/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options.signal,
  }, 0, "session", options.timeoutMs);

  sessionId = json.session_id;
  console.debug(`[${MODULE_NAME}] opened AIOS session ${sessionId}`);
  return sessionId;
}

async function activateRuntime(ctx, options = {}) {
  ensureIdentityMatches(ctx);
  if (instanceId) return instanceId;

  const { characterId, userName } = currentIdentity(ctx);
  if (!characterId || !userName) return null;

  await openSession(ctx, options);

  const maxAttempts = Math.max(1, Number(options.activationAttempts ?? 3));
  const retryDelay = Math.max(25, Number(options.activationRetryDelayMs ?? settings().retryDelayMs ?? 250));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) return null;

    try {
      const json = await requestJson(
        apiUrl(`/character/${encodeURIComponent(characterId)}/activate`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_name: userName,
            session_id: sessionId,
            scope_key: "conversation",
            controller_type: "agent",
            controller_ref: `sillytavern:${characterId}`,
          }),
          signal: options.signal,
        },
        0,
        `activate:${attempt}/${maxAttempts}`,
        options.timeoutMs,
      );

      instanceId = json.instance_id;
      console.debug(`[${MODULE_NAME}] activated AIOS runtime instance ${instanceId}`);
      return instanceId;
    } catch (error) {
      const isNotFound = String(error?.message ?? "").startsWith("404 ");
      if (!isNotFound || attempt >= maxAttempts || options.signal?.aborted) {
        console.warn(`[${MODULE_NAME}] runtime activation unavailable:`, error);
        return null;
      }

      console.debug(
        `[${MODULE_NAME}] character runtime not registered yet; retrying activation ${attempt + 1}/${maxAttempts}`,
      );

      await Promise.race([
        new Promise(resolve => setTimeout(resolve, retryDelay * attempt)),
        new Promise(resolve => options.signal?.addEventListener("abort", () => resolve(null), { once: true })),
      ]);
    }
  }

  return null;
}

function messageRole(message) {
  const isSystem = Boolean(message?.is_system);
  const isUser = !isSystem && Boolean(message?.is_user || message?.sender === "user");
  const isCharacter = !isSystem && !isUser;
  return { isSystem, isUser, isCharacter };
}

function latestMessage(ctx, speakerType) {
  return [...(ctx?.chat ?? [])].reverse().find(message => {
    const { isUser, isCharacter } = messageRole(message);
    return speakerType === "user" ? isUser : isCharacter;
  });
}

function messageById(ctx, messageId) {
  if (messageId === undefined || messageId === null || messageId === "") return null;
  return ctx?.chat?.[messageId] ?? null;
}

async function pushLine(speakerType, messageId = null) {
  const ctx = getContext();
  ensureIdentityMatches(ctx);

  let msg = messageById(ctx, messageId);
  let usedFallback = false;

  if (msg) {
    const { isUser, isCharacter } = messageRole(msg);
    const roleMatches = speakerType === "user" ? isUser : isCharacter;
    if (!roleMatches) {
      console.warn(`[${MODULE_NAME}] event message ${String(messageId)} did not match ${speakerType}; falling back`);
      msg = null;
    }
  }

  if (!msg) {
    msg = latestMessage(ctx, speakerType);
    usedFallback = true;
  }

  if (!msg?.mes) {
    console.warn(`[${MODULE_NAME}] no message found for ${speakerType}`, { messageId });
    return null;
  }

  if (usedFallback && messageId !== null && messageId !== undefined) {
    console.debug(`[${MODULE_NAME}] used latest-message fallback for ${speakerType}`, { messageId });
  }

  try {
    await openSession(ctx);

    const { characterId, userName } = currentIdentity(ctx);
    const speakerId = speakerType === "user" ? ctx.name1 : ctx.name2;
    const recipientId = ctx.groupId ? null : (speakerType === "user" ? ctx.name2 : ctx.name1);

    const payload = {
      session_id: sessionId,
      speaker_id: speakerId,
      speaker_type: speakerType,
      recipient_id: recipientId,
      viewpoint_id: speakerType === "character" ? characterId : null,
      character_id: characterId,
      user_name: userName,
      text: msg.mes,
      kind: "chat_message",
      scope_key: "conversation",
      payload: {
        source: "SillyTavern",
        chat_id: ctx?.chatId ?? null,
        group_id: ctx?.groupId ?? null,
        message_id: messageId ?? null,
      },
    };

    const json = await requestJson(apiUrl("/ingest"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, Number(settings().maxRetries ?? 1), `ingest:${speakerType}`);

    console.debug(`[${MODULE_NAME}] ingested ${speakerType}:`, json);
    return json;
  } catch (error) {
    console.error(`[${MODULE_NAME}] ingest failed:`, error);
    return null;
  }
}

function formatHudText(text) {
  if (!text) return "";
  if (!settings().tagWrapper) return text;
  return `<aios_hud>\nThe following is AIOS runtime context for the active character. Treat it as current character/world state and retrieved knowledge, not as dialogue spoken by the user.\n\n${text}\n</aios_hud>`;
}

function cachePreparedHud(json, nodeId) {
  const text = typeof json?.text === "string" ? json.text.trim() : "";
  if (!text) return null;
  cachedHudText = text;
  cachedHudFreshness = json?.freshness ?? null;
  latestPreparedNodeId = nodeId ?? json?.freshness?.requested_source_node_id ?? null;
  console.debug(`[${MODULE_NAME}] cached AIOS HUD`, {
    generation_ready: json?.generation_ready,
    requested_node: latestPreparedNodeId,
    freshness: cachedHudFreshness,
    chars: text.length,
  });
  console.debug(`[${MODULE_NAME}] AIOS HUD prompt returned:\n${text}`);
  return text;
}

async function prepareHud(ctx, nodeId, options = {}) {
  const runtimeId = await activateRuntime(ctx, options);
  if (!runtimeId) return null;

  const s = settings();
  const params = new URLSearchParams();
  if (nodeId) params.set("through_node_id", nodeId);
  params.set("recent_limit", String(Math.max(1, Number(s.recentLimit ?? 12))));
  if (Number(s.tokenBudget) > 0) params.set("token_budget", String(Math.max(256, Number(s.tokenBudget))));
  params.set("wait_ms", String(Math.max(0, Math.min(Number(options.prepareWaitMs ?? s.prepareWaitMs ?? 1200), 10000))));

  const json = await requestJson(
    apiUrl(`/instance/${encodeURIComponent(runtimeId)}/prepare?${params.toString()}`),
    { method: "POST", signal: options.signal },
    Number(options.retries ?? 0),
    "prepare",
    options.timeoutMs,
  );

  if (json?.generation_ready) {
    return cachePreparedHud(json, nodeId);
  }

  console.warn(`[${MODULE_NAME}] HUD returned but is not generation-ready`, json?.freshness ?? {});
  if (!s.requireGenerationReady) {
    return cachePreparedHud(json, nodeId);
  }
  return null;
}

async function fetchRuntimePrompt(ctx, options = {}) {
  const runtimeId = await activateRuntime(ctx, options);
  if (!runtimeId) return null;

  const s = settings();
  const params = new URLSearchParams({ recent_limit: String(Math.max(1, Number(s.recentLimit ?? 12))) });
  if (Number(s.tokenBudget) > 0) params.set("token_budget", String(Math.max(256, Number(s.tokenBudget))));
  params.set("wait_ms", "0");

  try {
    const json = await requestJson(
      apiUrl(`/instance/${encodeURIComponent(runtimeId)}/frame/text?${params.toString()}`),
      { method: "GET", signal: options.signal },
      0,
      "frame/text",
      options.timeoutMs,
    );
    const text = typeof json?.text === "string" && json.text.trim() ? json.text.trim() : null;
    if (text) console.debug(`[${MODULE_NAME}] AIOS HUD prompt returned (frame/text):\n${text}`);
    return text;
  } catch (error) {
    console.warn(`[${MODULE_NAME}] AIOS runtime frame fetch failed:`, error);
    return null;
  }
}

async function fetchLegacyMemoryPrompt(ctx, options = {}) {
  if (!settings().memoryFallback) return null;

  const { characterId, userName } = currentIdentity(ctx);
  const lastUserMsg = latestMessage(ctx, "user");
  if (!characterId || !lastUserMsg?.mes) return null;

  const url = apiUrl(
    `/memory?character=${encodeURIComponent(characterId)}` +
    `&user=${encodeURIComponent(userName)}` +
    `&scope=${encodeURIComponent("conversation")}` +
    `&context=${encodeURIComponent(lastUserMsg.mes)}`,
  );

  try {
    const json = await requestJson(url, { method: "GET", signal: options.signal }, 0, "memory-fallback", options.timeoutMs);
    const chunks = (json?.vector_matches ?? []).map(match => match?.content).filter(Boolean);
    return chunks.length ? chunks.join("\n---\n") : null;
  } catch (error) {
    console.warn(`[${MODULE_NAME}] legacy memory fetch failed:`, error);
    return null;
  }
}

function startHudPrefetch(ctx, nodeId) {
  if (!nodeId) return null;
  if (prefetchPromise && latestPreparedNodeId === nodeId) return prefetchPromise;

  const s = settings();
  prefetchPromise = prepareHud(ctx, nodeId, {
    timeoutMs: Math.max(Number(s.requestTimeoutMs ?? 1800), Number(s.prepareWaitMs ?? 1200) + 250),
    prepareWaitMs: s.prepareWaitMs,
    retries: 0,
  }).catch(error => {
    console.warn(`[${MODULE_NAME}] HUD prefetch failed:`, error);
    return null;
  }).finally(() => {
    prefetchPromise = null;
  });

  return prefetchPromise;
}

function injectPrompt(ctx, prompt, source = "fresh") {
  const s = settings();
  if (!prompt) {
    setExtensionPrompt(MODULE_NAME, "", s.position ?? extension_prompt_types.IN_PROMPT, s.depth ?? 1);
    return;
  }

  const { characterId } = currentIdentity(ctx);
  const injectionKey = `${characterId}::${instanceId ?? "memory"}::${latestPreparedNodeId ?? latestUserNodeId ?? "unknown"}::${prompt.length}::${source}`;
  if (injectionKey === lastInjectionKey) return;
  lastInjectionKey = injectionKey;

  setExtensionPrompt(
    MODULE_NAME,
    formatHudText(prompt),
    s.position ?? extension_prompt_types.IN_PROMPT,
    s.depth ?? 1,
  );

  console.debug(`[${MODULE_NAME}] injected AIOS HUD (${prompt.length} chars, ${source})`);
}

window[`${MODULE_NAME}_Intercept`] = async function (_chat, _maxContext, abort, type) {
  console.debug(`[${MODULE_NAME}] interceptor fired`, { type });
  if (type === "quiet") return;

  const s = settings();
  if (!s.enabled) return;

  const ctx = getContext();
  if (!ctx?.name2) return;
  ensureIdentityMatches(ctx);

  const lastUserMsg = latestMessage(ctx, "user");
  if (!lastUserMsg?.mes) return;

  const budgetMs = Math.max(50, Number(s.generationBudgetMs ?? 900));
  const generationController = new AbortController();
  const generationTimer = setTimeout(() => generationController.abort(new DOMException("AIOS generation budget exhausted", "TimeoutError")), budgetMs);
  const forwardAbort = () => generationController.abort(new DOMException("SillyTavern generation aborted", "AbortError"));

  if (abort?.signal) {
    if (abort.signal.aborted) forwardAbort();
    else abort.signal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    if (pendingUserIngest) {
      await Promise.race([
        pendingUserIngest,
        new Promise(resolve => generationController.signal.addEventListener("abort", () => resolve(null), { once: true })),
      ]);
    }

    if (generationController.signal.aborted) {
      if (s.useCachedHud && cachedHudText) injectPrompt(ctx, cachedHudText, "cached-budget");
      return;
    }

    let prompt = null;
    let coordinateConflict = false;
    const nodeId = latestUserNodeId;

    if (nodeId && latestPreparedNodeId === nodeId && cachedHudText) {
      prompt = cachedHudText;
    } else if (nodeId) {
      try {
        prompt = await prepareHud(ctx, nodeId, {
          signal: generationController.signal,
          timeoutMs: budgetMs,
          prepareWaitMs: Math.min(Number(s.prepareWaitMs ?? 1200), budgetMs),
          retries: 0,
        });
      } catch (error) {
        const message = String(error?.message ?? "");
        coordinateConflict = message.startsWith("409 ") && message.includes("current active source head");
        if (!generationController.signal.aborted) console.warn(`[${MODULE_NAME}] generation-time prepare failed:`, error);
        if (coordinateConflict) {
          console.debug(`[${MODULE_NAME}] stale generation coordinates detected; skipping current-head fallbacks for this generation`);
        }
      }
    }

    if (!prompt && s.useCachedHud && cachedHudText) {
      injectPrompt(ctx, cachedHudText, "cached");
      return;
    }

    if (!prompt && !coordinateConflict && !generationController.signal.aborted) {
      prompt = await fetchRuntimePrompt(ctx, { signal: generationController.signal, timeoutMs: Math.max(50, budgetMs / 2), retries: 0 });
    }

    if (!prompt && !coordinateConflict && !generationController.signal.aborted) {
      prompt = await fetchLegacyMemoryPrompt(ctx, { signal: generationController.signal, timeoutMs: Math.max(50, budgetMs / 2) });
    }

    if (prompt) injectPrompt(ctx, prompt, latestPreparedNodeId === nodeId ? "fresh" : "fallback");
    else if (!cachedHudText) injectPrompt(ctx, null);
  } catch (error) {
    console.warn(`[${MODULE_NAME}] interceptor failed open; SillyTavern generation will continue:`, error);
    if (s.useCachedHud && cachedHudText) injectPrompt(ctx, cachedHudText, "cached-error");
  } finally {
    clearTimeout(generationTimer);
    if (abort?.signal) abort.signal.removeEventListener("abort", forwardAbort);
  }
};

eventSource.on(LISTEN_SENT, (messageId) => {
  console.debug(`[${MODULE_NAME}] MESSAGE_SENT observed; starting non-blocking user ingest`, { messageId });
  const ctx = getContext();

  const ingestPromise = pushLine("user", messageId)
    .then(json => {
      latestUserNodeId = json?.node_id ?? null;
      if (latestUserNodeId) startHudPrefetch(ctx, latestUserNodeId);
      return json;
    })
    .finally(() => {
      if (pendingUserIngest === ingestPromise) pendingUserIngest = null;
    });

  pendingUserIngest = ingestPromise;

  // SillyTavern awaits MESSAGE_SENT listeners. Intentionally return immediately:
  // the tracked promise is observed later by the bounded generation interceptor.
});

eventSource.on(LISTEN_AI, () => {
  console.debug(`[${MODULE_NAME}] MESSAGE_RECEIVED observed; waiting for character render`);
  eventSource.once(LISTEN_AI_RENDERED, async (messageId) => {
    console.debug(`[${MODULE_NAME}] CHARACTER_MESSAGE_RENDERED observed`, { messageId });
    await pushLine("character", messageId);
  });
});

jQuery(async () => {
  const s = settings();
  const html = await renderExtensionTemplateAsync("third-party/MemoryVaultIngest", "settings");
  const container = $(document.getElementById("extensions_settings2"));
  container.append(html);

  $("#mvi_enabled").prop("checked", s.enabled).on("change", () => {
    s.enabled = !!$("#mvi_enabled").prop("checked");
    saveSettingsDebounced();
  });

  $("#mvi_api_root").val(s.apiRoot || DEFAULT_API_ROOT).on("change", () => {
    s.apiRoot = String($("#mvi_api_root").val() || DEFAULT_API_ROOT).trim();
    resetRuntimeIdentity();
    saveSettingsDebounced();
  });

  $(`input[name="mvi_position"][value="${s.position}"]`).prop("checked", true);
  $("input[name='mvi_position']").on("change", () => {
    s.position = Number($("input[name='mvi_position']:checked").val());
    saveSettingsDebounced();
  });

  $("#mvi_depth").val(s.depth).on("change", () => {
    s.depth = Number($("#mvi_depth").val());
    saveSettingsDebounced();
  });

  $("#mvi_recent_limit").val(s.recentLimit ?? 12).on("change", () => {
    s.recentLimit = Number($("#mvi_recent_limit").val());
    saveSettingsDebounced();
  });

  $("#mvi_token_budget").val(s.tokenBudget ?? 4000).on("change", () => {
    s.tokenBudget = Number($("#mvi_token_budget").val());
    saveSettingsDebounced();
  });

  $("#mvi_prepare_wait").val(s.prepareWaitMs ?? 1200).on("change", () => {
    s.prepareWaitMs = Number($("#mvi_prepare_wait").val());
    saveSettingsDebounced();
  });

  $("#mvi_generation_budget").val(s.generationBudgetMs ?? 900).on("change", () => {
    s.generationBudgetMs = Number($("#mvi_generation_budget").val());
    saveSettingsDebounced();
  });

  $("#mvi_require_ready").prop("checked", s.requireGenerationReady).on("change", () => {
    s.requireGenerationReady = !!$("#mvi_require_ready").prop("checked");
    saveSettingsDebounced();
  });

  $("#mvi_cached_hud").prop("checked", s.useCachedHud).on("change", () => {
    s.useCachedHud = !!$("#mvi_cached_hud").prop("checked");
    saveSettingsDebounced();
  });

  $("#mvi_tag").prop("checked", s.tagWrapper).on("change", () => {
    s.tagWrapper = !!$("#mvi_tag").prop("checked");
    saveSettingsDebounced();
  });

  $("#mvi_memory_fallback").prop("checked", s.memoryFallback).on("change", () => {
    s.memoryFallback = !!$("#mvi_memory_fallback").prop("checked");
    saveSettingsDebounced();
  });

  console.log(`[${MODULE_NAME}] settings panel registered`);
});

console.log(`[${MODULE_NAME}] v0.7.2 loaded (source-branch aware HUD prepare bridge)`);
