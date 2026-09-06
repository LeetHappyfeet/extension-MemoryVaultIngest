/* MemoryVaultIngest v0.6.1 – chat-aware AIOS ingest + runtime prompt bridge */

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
  maxRetries: 2,
  retryDelayMs: 500,
  tagWrapper: true,
  memoryFallback: true,
};

const LISTEN_SENT = event_types?.MESSAGE_SENT ?? "message_sent";
const LISTEN_USER = event_types?.USER_MESSAGE_RENDERED ?? "user_message_rendered";
const LISTEN_AI = event_types?.MESSAGE_RECEIVED ?? "message_received";
const LISTEN_AI_RENDERED = event_types?.CHARACTER_MESSAGE_RENDERED ?? "character_message_rendered";

let sessionId = null;
let instanceId = null;
let activeCharacterId = null;
let activeUserName = null;
let activeConversationKey = null;
let lastInjectionKey = null;

function settings() {
  if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
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
    console.debug(
      `[${MODULE_NAME}] runtime identity changed; resetting AIOS session`,
      {
        character_id: characterId,
        user_name: userName,
        conversation: nextConversationKey,
      },
    );
    resetRuntimeIdentity();
  }

  activeCharacterId = characterId;
  activeUserName = userName;
  activeConversationKey = nextConversationKey;
}

async function requestJson(url, options = {}, retries = 0, label = "request") {
  const retryDelay = Number(settings().retryDelayMs ?? 500);
  let lastError = null;
  const method = options?.method ?? "GET";

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.debug(
        `[${MODULE_NAME}] AIOS -> ${label} (${method}) attempt ${attempt + 1}/${retries + 1}`,
        url,
      );
      const response = await fetch(url, options);
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`${response.status} ${response.statusText}: ${body}`);
      }
      const json = await response.json();
      console.debug(`[${MODULE_NAME}] AIOS <- ${label} ${response.status}`);
      return json;
    } catch (error) {
      lastError = error;
      console.warn(`[${MODULE_NAME}] AIOS !! ${label} failed:`, error);
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  throw lastError;
}

async function openSession(ctx) {
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
  }, 0, "session");

  sessionId = json.session_id;
  console.debug(`[${MODULE_NAME}] opened AIOS session ${sessionId}`);
  return sessionId;
}

async function activateRuntime(ctx) {
  ensureIdentityMatches(ctx);
  if (instanceId) return instanceId;

  const { characterId, userName } = currentIdentity(ctx);
  if (!characterId || !userName) return null;

  await openSession(ctx);

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
      },
      Number(settings().maxRetries ?? 2),
      "activate",
    );

    instanceId = json.instance_id;
    console.debug(`[${MODULE_NAME}] activated AIOS runtime instance ${instanceId}`);
    return instanceId;
  } catch (error) {
    console.warn(`[${MODULE_NAME}] runtime activation unavailable:`, error);
    return null;
  }
}

function latestMessage(ctx, speakerType) {
  return [...(ctx?.chat ?? [])].reverse().find(message => {
    const isUser = message?.is_user || message?.sender === "user";
    return speakerType === "user" ? isUser : !isUser;
  });
}

async function pushLine(speakerType) {
  const ctx = getContext();
  ensureIdentityMatches(ctx);

  const msg = latestMessage(ctx, speakerType);
  if (!msg?.mes) {
    console.warn(`[${MODULE_NAME}] no message found for ${speakerType}`);
    return;
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
      },
    };

    const json = await requestJson(apiUrl("/ingest"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, Number(settings().maxRetries ?? 2), `ingest:${speakerType}`);

    console.debug(`[${MODULE_NAME}] ingested ${speakerType}:`, json);
  } catch (error) {
    console.error(`[${MODULE_NAME}] ingest failed:`, error);
  }
}

async function fetchRuntimePrompt(ctx) {
  const runtimeId = await activateRuntime(ctx);
  if (!runtimeId) return null;

  const recentLimit = Math.max(1, Number(settings().recentLimit ?? 12));
  try {
    const json = await requestJson(
      apiUrl(`/instance/${encodeURIComponent(runtimeId)}/frame/text?recent_limit=${recentLimit}`),
      { method: "GET" },
      Number(settings().maxRetries ?? 2),
      "frame/text",
    );
    return typeof json?.text === "string" && json.text.trim() ? json.text.trim() : null;
  } catch (error) {
    console.warn(`[${MODULE_NAME}] AIOS runtime frame fetch failed:`, error);
    return null;
  }
}

async function fetchLegacyMemoryPrompt(ctx) {
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
    const json = await requestJson(
      url,
      { method: "GET" },
      Number(settings().maxRetries ?? 2),
      "memory-fallback",
    );
    const chunks = (json?.vector_matches ?? []).map(match => match?.content).filter(Boolean);
    return chunks.length ? chunks.join("\n---\n") : null;
  } catch (error) {
    console.warn(`[${MODULE_NAME}] legacy memory fetch failed:`, error);
    return null;
  }
}

async function buildAiosPrompt(ctx) {
  const runtimePrompt = await fetchRuntimePrompt(ctx);
  if (runtimePrompt) return runtimePrompt;
  return await fetchLegacyMemoryPrompt(ctx);
}

window[`${MODULE_NAME}_Intercept`] = async function (_chat, _maxContext, _abort, type) {
  console.debug(`[${MODULE_NAME}] interceptor fired`, { type });
  if (type === "quiet") return;

  const s = settings();
  if (!s.enabled) return;

  const ctx = getContext();
  if (!ctx?.name2) return;

  ensureIdentityMatches(ctx);

  const lastUserMsg = latestMessage(ctx, "user");
  if (!lastUserMsg?.mes) return;

  const prompt = await buildAiosPrompt(ctx);
  if (!prompt) {
    setExtensionPrompt(
      MODULE_NAME,
      "",
      s.position ?? extension_prompt_types.IN_PROMPT,
      s.depth ?? 1,
    );
    return;
  }

  const { characterId } = currentIdentity(ctx);
  const injectionKey = `${characterId}::${instanceId ?? "memory"}::${lastUserMsg.mes}::${prompt.length}`;
  if (injectionKey === lastInjectionKey) return;
  lastInjectionKey = injectionKey;

  const formatted = s.tagWrapper
    ? `<aios_context>\n${prompt}\n</aios_context>`
    : prompt;

  setExtensionPrompt(
    MODULE_NAME,
    formatted,
    s.position ?? extension_prompt_types.IN_PROMPT,
    s.depth ?? 1,
  );

  console.debug(`[${MODULE_NAME}] injected AIOS prompt (${prompt.length} chars)`);
};

eventSource.on(LISTEN_SENT, () => {
  console.debug(`[${MODULE_NAME}] MESSAGE_SENT observed; waiting for user render`);
  eventSource.once(LISTEN_USER, async () => {
    console.debug(`[${MODULE_NAME}] USER_MESSAGE_RENDERED observed`);
    await pushLine("user");
  });
});

eventSource.on(LISTEN_AI, () => {
  console.debug(`[${MODULE_NAME}] MESSAGE_RECEIVED observed; waiting for character render`);
  eventSource.once(LISTEN_AI_RENDERED, async () => {
    console.debug(`[${MODULE_NAME}] CHARACTER_MESSAGE_RENDERED observed`);
    await pushLine("character");
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

console.log(`[${MODULE_NAME}] v0.6.1 loaded (chat-aware AIOS ingest + runtime prompt bridge)`);
