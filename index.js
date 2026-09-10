/* MemoryVaultIngest v0.8.3 – AIOS live HUD bridge and transcript reconciliation */

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
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const MIN_HUD_REQUEST_TIMEOUT_MS = 8000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;

const defaultSettings = {
  enabled: true,
  apiRoot: DEFAULT_API_ROOT,
  position: extension_prompt_types.IN_PROMPT,
  depth: 1,
  recentLimit: 12,
  tokenBudget: 4000,
  prepareWaitMs: 1200,
  generationBudgetMs: 900,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  maxRetries: 1,
  retryDelayMs: 250,
  requireGenerationReady: true,
  useCachedHud: true,
  tagWrapper: true,
  reconcileOnChatLoad: true,
  logHudText: true,
};

const LISTEN_SENT = event_types?.MESSAGE_SENT ?? "message_sent";
const LISTEN_AI = event_types?.MESSAGE_RECEIVED ?? "message_received";
const LISTEN_AI_RENDERED = event_types?.CHARACTER_MESSAGE_RENDERED ?? "character_message_rendered";
const LISTEN_CHAT_CHANGED = event_types?.CHAT_CHANGED ?? "chat_changed";
const LISTEN_MESSAGE_UPDATED = event_types?.MESSAGE_UPDATED ?? "message_updated";
const LISTEN_MESSAGE_SWIPED = event_types?.MESSAGE_SWIPED ?? "message_swiped";

let sessionId = null;
let instanceId = null;
let activeCharacterId = null;
let activeUserName = null;
let activeConversationKey = null;
let lastInjectionKey = null;
let pendingUserIngest = null;
let latestSourceNodeId = null;
let prefetchPromise = null;
let prefetchNodeId = null;
let prefetchController = null;
let desiredHudNodeId = null;
let reconciliationPromise = null;
let reconciliationGeneration = 0;
let bridgeState = "DISCONNECTED";
let hudCache = null;
let connectionState = "UNKNOWN";
let connectionDetail = "Not tested";
let connectionProbeTimer = null;

function settings() {
  if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
  } else {
    for (const [key, value] of Object.entries(defaultSettings)) {
      if (extension_settings[MODULE_NAME][key] === undefined) extension_settings[MODULE_NAME][key] = value;
    }
    delete extension_settings[MODULE_NAME].memoryFallback;
  }
  return extension_settings[MODULE_NAME];
}

function normalizeApiRoot(value) {
  let root = String(value ?? "").trim();
  if (!root) root = DEFAULT_API_ROOT;
  if (!/^https?:\/\//i.test(root)) root = `http://${root}`;
  const parsed = new URL(root);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("AIOS URL must use http:// or https://");
  return root.replace(/\/+$/, "");
}

function renderConnectionState(state = connectionState, detail = connectionDetail) {
  const dot = document.getElementById("mvi_connection_dot");
  const label = document.getElementById("mvi_connection_status");
  const detailNode = document.getElementById("mvi_connection_detail");
  if (!dot || !label) return;

  const palette = {
    CONNECTED: "#49c26b",
    CONNECTING: "#e6b94f",
    DISCONNECTED: "#e05a5a",
    UNKNOWN: "#8b8b8b",
  };
  dot.style.background = palette[state] ?? palette.UNKNOWN;
  dot.style.boxShadow = `0 0 7px ${palette[state] ?? palette.UNKNOWN}`;
  label.textContent = state === "CONNECTED" ? "Connected" : state === "CONNECTING" ? "Connecting…" : state === "DISCONNECTED" ? "Disconnected" : "Not tested";
  if (detailNode) detailNode.textContent = detail || "";
}

function setConnectionState(state, detail = "") {
  connectionState = state;
  connectionDetail = detail;
  renderConnectionState();
}

function setBridgeState(next, detail = null) {
  if (bridgeState === next && !detail) return;
  bridgeState = next;
  console.debug(`[${MODULE_NAME}] state -> ${next}`, detail ?? "");
}

function normalizeCharId(name) {
  return String(name ?? "").trim().replace(/\s+/g, "_");
}

function apiUrl(path) {
  return `${normalizeApiRoot(settings().apiRoot || DEFAULT_API_ROOT)}${path}`;
}

function clearHudCache() {
  hudCache = null;
  lastInjectionKey = null;
}

function resetRuntimeIdentity() {
  if (prefetchController && !prefetchController.signal.aborted) {
    prefetchController.abort(new DOMException("AIOS runtime identity reset", "AbortError"));
  }
  sessionId = null;
  instanceId = null;
  activeCharacterId = null;
  activeUserName = null;
  activeConversationKey = null;
  pendingUserIngest = null;
  latestSourceNodeId = null;
  desiredHudNodeId = null;
  prefetchPromise = null;
  prefetchNodeId = null;
  prefetchController = null;
  reconciliationPromise = null;
  reconciliationGeneration += 1;
  clearHudCache();
  setBridgeState("DISCONNECTED");
}

function conversationKey(ctx) {
  if (ctx?.groupId) return `group:${ctx.groupId}`;
  if (ctx?.chatId !== undefined && ctx?.chatId !== null && String(ctx.chatId) !== "") return `chat:${ctx.chatId}`;
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
  const changed =
    (activeCharacterId && activeCharacterId !== characterId) ||
    (activeUserName && activeUserName !== userName) ||
    (activeConversationKey && activeConversationKey !== nextConversationKey);
  if (changed) {
    console.debug(`[${MODULE_NAME}] runtime identity changed; resetting AIOS bridge`, {
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
  const timer = setTimeout(() => controller.abort(new DOMException("AIOS request timed out", "TimeoutError")), Math.max(1, Number(timeoutMs || 1)));
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
  const requestTimeout = Math.max(50, Number(timeoutMs ?? settings().requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
  let lastError = null;
  const method = options?.method ?? "GET";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const bounded = timeoutSignal(requestTimeout, options?.signal ?? null);
    try {
      console.debug(`[${MODULE_NAME}] AIOS -> ${label} (${method}) attempt ${attempt + 1}/${retries + 1}`, url);
      const response = await fetch(url, { ...options, signal: bounded.signal });
      if (!response.ok) {
        const body = await response.text();
        const error = new Error(`${response.status} ${response.statusText}: ${body}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      const json = await response.json();
      setConnectionState("CONNECTED", normalizeApiRoot(settings().apiRoot));
      console.debug(`[${MODULE_NAME}] AIOS <- ${label} ${response.status}`);
      return json;
    } catch (error) {
      lastError = error;
      const aborted = bounded.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
      console.warn(`[${MODULE_NAME}] AIOS !! ${label} failed:`, error);
      if (!options?.signal?.aborted) setConnectionState("DISCONNECTED", String(error?.message ?? "Connection failed"));
      if (aborted) break;
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, retryDelay));
    } finally {
      bounded.cleanup();
    }
  }
  throw lastError;
}

async function probeConnection(options = {}) {
  const timeoutMs = Math.max(HEALTH_CHECK_TIMEOUT_MS, Number(options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS));
  let root;
  try {
    root = normalizeApiRoot(options.apiRoot ?? settings().apiRoot);
  } catch (error) {
    setConnectionState("DISCONNECTED", error.message);
    return false;
  }

  setConnectionState("CONNECTING", root);
  const bounded = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(`${root}/healthz`, { method: "GET", signal: bounded.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}`);
    setConnectionState("CONNECTED", root);
    console.debug(`[${MODULE_NAME}] AIOS health check OK`, root);
    return true;
  } catch (error) {
    setConnectionState("DISCONNECTED", `${root} — ${error?.message ?? "unreachable"}`);
    console.warn(`[${MODULE_NAME}] AIOS health check failed`, error);
    return false;
  } finally {
    bounded.cleanup();
  }
}

function startConnectionMonitor() {
  if (connectionProbeTimer) clearInterval(connectionProbeTimer);
  connectionProbeTimer = setInterval(() => {
    if (settings().enabled) void probeConnection({ timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  }, 15000);
}

async function openSession(ctx, options = {}) {
  ensureIdentityMatches(ctx);
  if (sessionId) return sessionId;
  const { characterId, userName, conversationKey: sourceSessionId } = currentIdentity(ctx);
  const json = await requestJson(apiUrl("/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: `${characterId || "chat"}-${sourceSessionId}`,
      source: "SillyTavern",
      source_session_id: sourceSessionId,
      meta: {
        character_id: characterId,
        user_name: userName,
        chat_id: ctx?.chatId ?? null,
        group_id: ctx?.groupId ?? null,
      },
    }),
    signal: options.signal,
  }, 0, "session", options.timeoutMs);
  sessionId = json.session_id;
  setBridgeState("SESSION_RESOLVED", { session_id: sessionId, source_session_id: sourceSessionId });
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
      setBridgeState("RUNTIME_ACTIVE", { instance_id: instanceId });
      return instanceId;
    } catch (error) {
      const notFound = error?.status === 404 || String(error?.message ?? "").startsWith("404 ");
      if (!notFound || attempt >= maxAttempts || options.signal?.aborted) {
        console.warn(`[${MODULE_NAME}] runtime activation unavailable:`, error);
        setBridgeState("DEGRADED", { reason: "runtime_activation" });
        return null;
      }
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
  return { isSystem, isUser, isCharacter: !isSystem && !isUser };
}

function latestMessage(ctx, speakerType) {
  return [...(ctx?.chat ?? [])].reverse().find(message => {
    const { isUser, isCharacter } = messageRole(message);
    return speakerType === "user" ? isUser : isCharacter;
  });
}

function messageById(ctx, messageId) {
  if (messageId === undefined || messageId === null || messageId === "") return null;
  return ctx?.chat?.[Number(messageId)] ?? null;
}

async function ingestMessage(ctx, messageId, msg, options = {}) {
  if (!msg?.mes || msg.is_system) return null;
  ensureIdentityMatches(ctx);
  await openSession(ctx, options);
  const { isUser, isCharacter } = messageRole(msg);
  if (!isUser && !isCharacter) return null;
  const speakerType = isUser ? "user" : "character";
  const { characterId, userName } = currentIdentity(ctx);
  const json = await requestJson(apiUrl("/ingest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      speaker_id: isUser ? ctx.name1 : ctx.name2,
      speaker_type: speakerType,
      recipient_id: ctx.groupId ? null : (isUser ? ctx.name2 : ctx.name1),
      viewpoint_id: isCharacter ? characterId : null,
      character_id: characterId,
      user_name: userName,
      text: msg.mes,
      kind: "chat_message",
      scope_key: "conversation",
      payload: {
        source: "SillyTavern",
        chat_id: ctx?.chatId ?? null,
        group_id: ctx?.groupId ?? null,
        message_id: Number(messageId),
        swipe_id: msg?.swipe_id ?? msg?.swipeId ?? null,
      },
    }),
    signal: options.signal,
  }, Number(options.retries ?? settings().maxRetries ?? 1), `ingest:${speakerType}:${messageId}`, options.timeoutMs);
  latestSourceNodeId = json?.node_id ?? latestSourceNodeId;
  if (json?.node_id) desiredHudNodeId = json.node_id;
  console.debug(`[${MODULE_NAME}] ingested source slot ${messageId}`, { speaker_type: speakerType, node_id: json?.node_id ?? null });
  return json;
}

async function pushLine(speakerType, messageId = null) {
  const ctx = getContext();
  ensureIdentityMatches(ctx);
  let msg = messageById(ctx, messageId);
  if (msg) {
    const role = messageRole(msg);
    if ((speakerType === "user" && !role.isUser) || (speakerType === "character" && !role.isCharacter)) msg = null;
  }
  if (!msg) msg = latestMessage(ctx, speakerType);
  if (!msg?.mes) return null;
  let resolvedMessageId = messageId;
  if (resolvedMessageId === null || resolvedMessageId === undefined || !messageById(ctx, resolvedMessageId)) resolvedMessageId = (ctx?.chat ?? []).indexOf(msg);
  if (resolvedMessageId < 0) return null;
  try {
    return await ingestMessage(ctx, resolvedMessageId, msg);
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

function cacheHud(json, requestedNodeId) {
  const resolvedNodeId = requestedNodeId ?? json?.freshness?.requested_source_node_id ?? null;
  if (resolvedNodeId && desiredHudNodeId && resolvedNodeId !== desiredHudNodeId) {
    console.debug(`[${MODULE_NAME}] ignoring stale HUD completion`, {
      requested_node: resolvedNodeId,
      desired_node: desiredHudNodeId,
    });
    return null;
  }
  const text = typeof json?.text === "string" ? json.text.trim() : "";
  if (!text) return null;
  hudCache = {
    sessionId,
    instanceId,
    conversationKey: activeConversationKey,
    requestedNodeId: resolvedNodeId,
    sourceTimelineId: json?.freshness?.source_timeline_id ?? json?.frame?.source_timeline_id ?? null,
    sourceHeadNodeId: json?.freshness?.source_head_node_id ?? json?.freshness?.current_source_head_node_id ?? null,
    generationReady: Boolean(json?.generation_ready),
    freshness: json?.freshness ?? null,
    frame: json?.frame ?? null,
    text,
    preparedAt: Date.now(),
  };
  console.debug(`[${MODULE_NAME}] cached AIOS HUD`, {
    generation_ready: hudCache.generationReady,
    requested_node: hudCache.requestedNodeId,
    source_head_node: hudCache.sourceHeadNodeId,
    freshness: hudCache.freshness,
    chars: text.length,
  });
  if (settings().logHudText) console.debug(`[${MODULE_NAME}] AIOS HUD prompt returned:\n${text}`);
  setBridgeState(hudCache.generationReady ? "READY" : "DEGRADED", hudCache.freshness);
  return text;
}

function cachedHudIsCompatible(ctx, requestedNodeId = null) {
  if (!hudCache?.text) return false;
  const identity = currentIdentity(ctx);
  if (hudCache.sessionId !== sessionId || hudCache.instanceId !== instanceId || hudCache.conversationKey !== identity.conversationKey) return false;
  if (requestedNodeId && hudCache.requestedNodeId && hudCache.requestedNodeId !== requestedNodeId) return false;
  return true;
}

async function prepareHud(ctx, nodeId, options = {}) {
  const runtimeId = await activateRuntime(ctx, options);
  if (!runtimeId) return null;
  setBridgeState("HUD_PREPARING", { through_node_id: nodeId ?? null });
  const s = settings();
  const prepareWaitMs = Math.max(0, Math.min(Number(options.prepareWaitMs ?? s.prepareWaitMs ?? 1200), 10000));
  const hudRequestTimeoutMs = Math.max(
    MIN_HUD_REQUEST_TIMEOUT_MS,
    Number(options.timeoutMs ?? s.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    prepareWaitMs + 3000,
  );
  const params = new URLSearchParams();
  if (nodeId) params.set("through_node_id", nodeId);
  params.set("recent_limit", String(Math.max(1, Number(s.recentLimit ?? 12))));
  if (Number(s.tokenBudget) > 0) params.set("token_budget", String(Math.max(256, Number(s.tokenBudget))));
  params.set("wait_ms", String(prepareWaitMs));
  const json = await requestJson(
    apiUrl(`/instance/${encodeURIComponent(runtimeId)}/hud?${params.toString()}`),
    { method: "POST", signal: options.signal },
    Number(options.retries ?? 0),
    "hud",
    hudRequestTimeoutMs,
  );
  if (json?.generation_ready || !s.requireGenerationReady) return cacheHud(json, nodeId);
  console.warn(`[${MODULE_NAME}] HUD returned but is not generation-ready`, json?.freshness ?? {});
  setBridgeState("DEGRADED", json?.freshness ?? null);
  return null;
}

function startHudPrefetch(ctx, nodeId) {
  if (!nodeId) return null;
  desiredHudNodeId = nodeId;

  if (prefetchPromise && prefetchNodeId === nodeId) {
    console.debug(`[${MODULE_NAME}] HUD prefetch REUSE`, { node_id: nodeId });
    return prefetchPromise;
  }

  if (prefetchController && !prefetchController.signal.aborted) {
    console.debug(`[${MODULE_NAME}] HUD prefetch SUPERSEDE`, {
      from_node: prefetchNodeId,
      to_node: nodeId,
    });
    prefetchController.abort(new DOMException("HUD prefetch superseded", "AbortError"));
  }

  const s = settings();
  const controller = new AbortController();
  const startedAt = performance.now();
  prefetchController = controller;
  prefetchNodeId = nodeId;

  console.debug(`[${MODULE_NAME}] HUD prefetch START`, { node_id: nodeId });

  const promise = prepareHud(ctx, nodeId, {
    signal: controller.signal,
    timeoutMs: Math.max(DEFAULT_REQUEST_TIMEOUT_MS, Number(s.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)),
    prepareWaitMs: s.prepareWaitMs,
    retries: 0,
  }).then(prompt => {
    const elapsed_ms = Math.round(performance.now() - startedAt);
    if (nodeId !== desiredHudNodeId) {
      console.debug(`[${MODULE_NAME}] HUD prefetch STALE-DISCARD`, {
        node_id: nodeId,
        desired_node: desiredHudNodeId,
        elapsed_ms,
      });
      return null;
    }
    console.debug(`[${MODULE_NAME}] HUD prefetch COMPLETE`, { node_id: nodeId, elapsed_ms, cached: Boolean(prompt) });
    return prompt;
  }).catch(error => {
    const elapsed_ms = Math.round(performance.now() - startedAt);
    if (controller.signal.aborted) {
      console.debug(`[${MODULE_NAME}] HUD prefetch ABORT`, { node_id: nodeId, elapsed_ms, reason: controller.signal.reason?.message ?? "aborted" });
      return null;
    }
    console.warn(`[${MODULE_NAME}] HUD prefetch failed:`, error);
    setBridgeState("DEGRADED", { reason: "hud_prefetch", node_id: nodeId, elapsed_ms });
    return null;
  }).finally(() => {
    if (prefetchPromise === promise) {
      prefetchPromise = null;
      prefetchNodeId = null;
      prefetchController = null;
    }
  });

  prefetchPromise = promise;
  return promise;
}

function injectPrompt(ctx, prompt, source = "fresh") {
  const s = settings();
  if (!prompt) {
    setExtensionPrompt(MODULE_NAME, "", s.position ?? extension_prompt_types.IN_PROMPT, s.depth ?? 1);
    return;
  }
  const { characterId } = currentIdentity(ctx);
  const coordinate = hudCache?.requestedNodeId ?? latestSourceNodeId ?? "unknown";
  const injectionKey = `${characterId}::${instanceId ?? "none"}::${coordinate}::${prompt.length}::${source}`;
  if (injectionKey === lastInjectionKey) return;
  lastInjectionKey = injectionKey;
  setExtensionPrompt(MODULE_NAME, formatHudText(prompt), s.position ?? extension_prompt_types.IN_PROMPT, s.depth ?? 1);
  console.debug(`[${MODULE_NAME}] injected AIOS HUD (${prompt.length} chars, ${source})`, {
    through_node_id: coordinate,
    freshness: hudCache?.freshness ?? null,
  });
}

async function reconcileConversation(ctx = getContext()) {
  const s = settings();
  if (!s.enabled || !s.reconcileOnChatLoad || !ctx?.name2) return null;
  ensureIdentityMatches(ctx);
  if (reconciliationPromise) return reconciliationPromise;
  const generation = ++reconciliationGeneration;
  const conversation = currentIdentity(ctx).conversationKey;
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
  reconciliationPromise = (async () => {
    try {
      setBridgeState("SYNCING", { conversation, messages: chat.length });
      await openSession(ctx);
      let ingested = 0;
      let finalNodeId = latestSourceNodeId;
      for (let messageId = 0; messageId < chat.length; messageId++) {
        if (generation !== reconciliationGeneration || conversation !== currentIdentity(getContext()).conversationKey) return null;
        const msg = chat[messageId];
        if (!msg?.mes || msg.is_system) continue;
        try {
          const json = await ingestMessage(ctx, messageId, msg, { retries: 0 });
          if (json?.node_id) finalNodeId = json.node_id;
          ingested += 1;
        } catch (error) {
          console.warn(`[${MODULE_NAME}] transcript reconciliation skipped source slot ${messageId}:`, error);
        }
      }
      latestSourceNodeId = finalNodeId;
      desiredHudNodeId = finalNodeId ?? desiredHudNodeId;
      console.debug(`[${MODULE_NAME}] transcript reconciliation complete`, {
        conversation,
        messages_seen: chat.length,
        messages_ingested: ingested,
        source_head_node_id: finalNodeId ?? null,
      });
      const runtimeId = await activateRuntime(ctx);
      if (!runtimeId) return null;
      if (finalNodeId) return await startHudPrefetch(ctx, finalNodeId);
      return null;
    } catch (error) {
      console.warn(`[${MODULE_NAME}] conversation reconciliation failed open:`, error);
      setBridgeState("DEGRADED", { reason: "reconciliation" });
      return null;
    } finally {
      if (generation === reconciliationGeneration) reconciliationPromise = null;
    }
  })();
  return reconciliationPromise;
}

window[`${MODULE_NAME}_Intercept`] = async function (_chat, _maxContext, abort, type) {
  console.debug(`[${MODULE_NAME}] interceptor fired`, { type, state: bridgeState });
  if (type === "quiet") return;
  const s = settings();
  if (!s.enabled) return;
  const ctx = getContext();
  if (!ctx?.name2) return;
  ensureIdentityMatches(ctx);
  if (!latestMessage(ctx, "user")?.mes) return;
  const budgetMs = Math.max(50, Number(s.generationBudgetMs ?? 900));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("AIOS generation budget exhausted", "TimeoutError")), budgetMs);
  const forwardAbort = () => controller.abort(new DOMException("SillyTavern generation aborted", "AbortError"));
  if (abort?.signal) {
    if (abort.signal.aborted) forwardAbort();
    else abort.signal.addEventListener("abort", forwardAbort, { once: true });
  }
  try {
    if (pendingUserIngest) {
      await Promise.race([
        pendingUserIngest,
        new Promise(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true })),
      ]);
    }
    const nodeId = latestSourceNodeId;
    if (controller.signal.aborted) {
      if (s.useCachedHud && cachedHudIsCompatible(ctx, nodeId)) injectPrompt(ctx, hudCache.text, "cached-budget");
      return;
    }
    let prompt = null;
    let promptSource = "fresh";
    if (nodeId && cachedHudIsCompatible(ctx, nodeId)) {
      prompt = hudCache.text;
      promptSource = "cached-exact";
    } else if (nodeId && prefetchPromise && prefetchNodeId === nodeId) {
      console.debug(`[${MODULE_NAME}] generation reusing in-flight HUD prefetch`, { node_id: nodeId, budget_ms: budgetMs });
      prompt = await Promise.race([
        prefetchPromise,
        new Promise(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true })),
      ]);
      promptSource = "prefetch";
    } else if (nodeId) {
      try {
        prompt = await prepareHud(ctx, nodeId, {
          signal: controller.signal,
          timeoutMs: budgetMs,
          prepareWaitMs: Math.min(Number(s.prepareWaitMs ?? 1200), budgetMs),
          retries: 0,
        });
      } catch (error) {
        if (error?.status === 409 || String(error?.message ?? "").startsWith("409 ")) {
          console.warn(`[${MODULE_NAME}] exact HUD coordinate rejected; obsolete live fallbacks are disabled`, { through_node_id: nodeId });
        } else if (!controller.signal.aborted) {
          console.warn(`[${MODULE_NAME}] generation-time HUD request failed:`, error);
        }
      }
    }
    if (prompt) return injectPrompt(ctx, prompt, promptSource);
    if (s.useCachedHud && cachedHudIsCompatible(ctx)) return injectPrompt(ctx, hudCache.text, "cached");
    injectPrompt(ctx, null);
    console.debug(`[${MODULE_NAME}] no safe AIOS HUD available; generation continues without AIOS injection`);
  } catch (error) {
    console.warn(`[${MODULE_NAME}] interceptor failed open; SillyTavern generation will continue:`, error);
    if (s.useCachedHud && cachedHudIsCompatible(ctx)) injectPrompt(ctx, hudCache.text, "cached-error");
  } finally {
    clearTimeout(timer);
    if (abort?.signal) abort.signal.removeEventListener("abort", forwardAbort);
  }
};

eventSource.on(LISTEN_SENT, (messageId) => {
  console.debug(`[${MODULE_NAME}] MESSAGE_SENT observed; starting non-blocking user ingest`, { messageId });
  const ctx = getContext();
  ensureIdentityMatches(ctx);
  const ingestPromise = pushLine("user", messageId)
    .then(json => {
      latestSourceNodeId = json?.node_id ?? latestSourceNodeId;
      if (json?.node_id) desiredHudNodeId = json.node_id;
      if (latestSourceNodeId) startHudPrefetch(ctx, latestSourceNodeId);
      return json;
    })
    .finally(() => { if (pendingUserIngest === ingestPromise) pendingUserIngest = null; });
  pendingUserIngest = ingestPromise;
});

eventSource.on(LISTEN_AI, () => {
  console.debug(`[${MODULE_NAME}] MESSAGE_RECEIVED observed; waiting for character render`);
  eventSource.once(LISTEN_AI_RENDERED, async (messageId) => {
    console.debug(`[${MODULE_NAME}] CHARACTER_MESSAGE_RENDERED observed`, { messageId });
    const json = await pushLine("character", messageId);
    latestSourceNodeId = json?.node_id ?? latestSourceNodeId;
    if (json?.node_id) desiredHudNodeId = json.node_id;
    if (latestSourceNodeId) startHudPrefetch(getContext(), latestSourceNodeId);
  });
});

eventSource.on(LISTEN_CHAT_CHANGED, () => {
  console.debug(`[${MODULE_NAME}] CHAT_CHANGED observed; reconciling active transcript`);
  resetRuntimeIdentity();
  const ctx = getContext();
  ensureIdentityMatches(ctx);
  void reconcileConversation(ctx);
});

for (const eventName of [LISTEN_MESSAGE_UPDATED, LISTEN_MESSAGE_SWIPED]) {
  eventSource.on(eventName, async (messageId) => {
    const ctx = getContext();
    ensureIdentityMatches(ctx);
    const msg = messageById(ctx, messageId);
    if (!msg?.mes || msg.is_system) return;
    try {
      const json = await ingestMessage(ctx, Number(messageId), msg, { retries: 0 });
      latestSourceNodeId = json?.node_id ?? latestSourceNodeId;
      if (json?.node_id) desiredHudNodeId = json.node_id;
      if (latestSourceNodeId) startHudPrefetch(ctx, latestSourceNodeId);
    } catch (error) {
      console.warn(`[${MODULE_NAME}] source-slot update sync failed`, { eventName, messageId, error });
    }
  });
}

jQuery(async () => {
  const s = settings();
  const html = await renderExtensionTemplateAsync("third-party/MemoryVaultIngest", "settings");
  $(document.getElementById("extensions_settings2")).append(html);

  const apiRootInput = $("#mvi_api_root");
  apiRootInput.val(s.apiRoot || DEFAULT_API_ROOT);
  renderConnectionState();

  $("#mvi_connect").on("click", async () => {
    let root;
    try {
      root = normalizeApiRoot(apiRootInput.val());
    } catch (error) {
      setConnectionState("DISCONNECTED", error.message);
      return;
    }
    apiRootInput.val(root);
    s.apiRoot = root;
    resetRuntimeIdentity();
    saveSettingsDebounced();
    const connected = await probeConnection({ apiRoot: root });
    if (connected && s.enabled) void reconcileConversation(getContext());
  });

  apiRootInput.on("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("#mvi_connect").trigger("click");
    }
  });

  $("#mvi_enabled").prop("checked", s.enabled).on("change", () => {
    s.enabled = !!$("#mvi_enabled").prop("checked");
    saveSettingsDebounced();
    if (s.enabled) {
      void probeConnection();
      void reconcileConversation(getContext());
    } else {
      injectPrompt(getContext(), null);
    }
  });
  $(`input[name="mvi_position"][value="${s.position}"]`).prop("checked", true);
  $("input[name='mvi_position']").on("change", () => { s.position = Number($("input[name='mvi_position']:checked").val()); saveSettingsDebounced(); });
  $("#mvi_depth").val(s.depth).on("change", () => { s.depth = Number($("#mvi_depth").val()); saveSettingsDebounced(); });
  $("#mvi_recent_limit").val(s.recentLimit ?? 12).on("change", () => { s.recentLimit = Number($("#mvi_recent_limit").val()); saveSettingsDebounced(); });
  $("#mvi_token_budget").val(s.tokenBudget ?? 4000).on("change", () => { s.tokenBudget = Number($("#mvi_token_budget").val()); saveSettingsDebounced(); });
  $("#mvi_prepare_wait").val(s.prepareWaitMs ?? 1200).on("change", () => { s.prepareWaitMs = Number($("#mvi_prepare_wait").val()); saveSettingsDebounced(); });
  $("#mvi_generation_budget").val(s.generationBudgetMs ?? 900).on("change", () => { s.generationBudgetMs = Number($("#mvi_generation_budget").val()); saveSettingsDebounced(); });
  $("#mvi_require_ready").prop("checked", s.requireGenerationReady).on("change", () => { s.requireGenerationReady = !!$("#mvi_require_ready").prop("checked"); saveSettingsDebounced(); });
  $("#mvi_cached_hud").prop("checked", s.useCachedHud).on("change", () => { s.useCachedHud = !!$("#mvi_cached_hud").prop("checked"); saveSettingsDebounced(); });
  $("#mvi_tag").prop("checked", s.tagWrapper).on("change", () => { s.tagWrapper = !!$("#mvi_tag").prop("checked"); saveSettingsDebounced(); });
  $("#mvi_reconcile").prop("checked", s.reconcileOnChatLoad).on("change", () => { s.reconcileOnChatLoad = !!$("#mvi_reconcile").prop("checked"); saveSettingsDebounced(); if (s.reconcileOnChatLoad) void reconcileConversation(getContext()); });
  $("#mvi_log_hud").prop("checked", s.logHudText).on("change", () => { s.logHudText = !!$("#mvi_log_hud").prop("checked"); saveSettingsDebounced(); });

  console.log(`[${MODULE_NAME}] settings panel registered`);
  startConnectionMonitor();
  queueMicrotask(async () => {
    await probeConnection();
    void reconcileConversation(getContext());
  });
});

console.log(`[${MODULE_NAME}] v0.8.3 loaded (coordinate-aware single-flight AIOS HUD bridge)`);
