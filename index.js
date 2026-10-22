import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { AIOSBridge, MODULE, VERSION, defaults, normalizeRoot, selectedCard, normalizeId, uuid, digest, exactHud } from './bridge.js';

function settings() {
    extension_settings[MODULE] ||= {};
    for (const [key, value] of Object.entries(defaults)) extension_settings[MODULE][key] ??= value;
    return extension_settings[MODULE];
}
let panelReady = false;
let generationController = null;
let generationSequence = 0;
let lastLore = [];
let monitor;
let operationBusy = false;
const el = id => document.getElementById(id);
const show = (id, value) => { if (el(id)) el(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
const bridge = new AIOSBridge({ getContext, settings, onChange: status => {
    show('mvi_runtime_status', `${status.state}${status.character_id ? ` — ${status.character_id}` : ''}${status.error ? `: ${status.error}` : ''}`);
    if (status.freshness) show('mvi_freshness', status.freshness);
    if (status.frame) show('mvi_frame', status.frame);
    if (status.state === 'SYNC_BLOCKED') clearPrompt();
} });

function clearPrompt() {
    setExtensionPrompt(MODULE, '', settings().position ?? extension_prompt_types.IN_PROMPT, settings().depth);
}
function report(error) {
    if (error?.name === 'AbortError') return;
    console.warn(`[${MODULE}]`, error);
    show('mvi_runtime_status', error?.message || String(error));
}
function currentScope() {
    return bridge.scope();
}
async function persistCharacterId(ctx, card) {
    const index = (ctx.characters || []).indexOf(card);
    if (index < 0 || !card.avatar || !ctx.writeExtensionField) return;
    const current = card.data?.extensions?.[MODULE] || {};
    const id = current.character_id || settings().characterIds?.[card.avatar] || normalizeId(card.name || card.data?.name);
    if (!id) return;
    settings().characterIds ||= {};
    settings().characterIds[card.avatar] = id;
    saveSettingsDebounced();
    if (!current.character_id) {
        // Set locally before ST emits CHARACTER_EDITED to avoid recursive writes.
        card.data ||= {};
        card.data.extensions ||= {};
        card.data.extensions[MODULE] = { ...current, character_id: id };
        try { await ctx.writeExtensionField(index, MODULE, { ...current, character_id: id }); }
        catch (error) { console.warn(`[${MODULE}] Card mapping uses local settings fallback:`, error.message); }
    }
}
async function synchronize() {
    if (!settings().enabled) return;
    const ctx = getContext();
    try {
        const card = selectedCard(ctx, null, bridge.drafted);
        const metadata = ctx.chatMetadata;
        const epoch = bridge.epoch;
        await persistCharacterId(ctx, card);
        if (metadata !== getContext().chatMetadata || epoch !== bridge.epoch) return;
        const scope = bridge.scope(ctx, card);
        show('mvi_character_id', scope.data.character_id);
        if (settings().reconcileOnChatLoad) await bridge.reconcile(scope);
        else await scope.live.queue.run(() => bridge.connect(scope));
        if (bridge.current(scope)) void bridge.prefetch(scope);
    } catch (error) { report(error); }
}
async function probe() {
    if (!settings().enabled) return;
    show('mvi_connection_status', 'Checking HTTP connection…');
    const epoch = bridge.epoch;
    try {
        const root = normalizeRoot(settings().apiRoot);
        await bridge.request(root, '/healthz', { timeoutMs: 3000 });
        if (epoch !== bridge.epoch || !settings().enabled || root !== normalizeRoot(settings().apiRoot)) return;
        show('mvi_connection_status', 'HTTP reachable');
        show('mvi_connection_detail', 'API reachable. Runtime and HUD readiness are shown separately below.');
        if (el('mvi_connection_dot')) el('mvi_connection_dot').style.background = '#49c26b';
    } catch (error) {
        if (epoch !== bridge.epoch || !settings().enabled) return;
        show('mvi_connection_status', 'Disconnected');
        show('mvi_connection_detail', error.message);
        if (el('mvi_connection_dot')) el('mvi_connection_dot').style.background = '#e05a5a';
    }
}
function reset() {
    generationController?.abort();
    generationSequence++;
    bridge.reset();
    clearPrompt();
    lastLore = [];
    show('mvi_result', '');
    show('mvi_frame', '');
    show('mvi_freshness', '');
    show('mvi_dossiers', '');
    show('mvi_sources', '');
}
function listen(name, handler) {
    const event = event_types?.[name];
    if (event) eventSource.on(event, handler);
}
function liveMessage(index, dispatchResearch = false) {
    if (!settings().enabled) return;
    const ctx = getContext();
    const message = ctx.chat?.[Number(index)];
    if (!message?.mes || message.is_system) return;
    try {
        const scope = currentScope();
        // submit() enqueues synchronously, before ST starts its next generation.
        void bridge.submit(scope, Number(index), message, { dispatchResearch }).then(() => bridge.prefetch(scope)).catch(report);
    } catch (error) { report(error); }
}
listen('MESSAGE_SENT', index => liveMessage(index));
// Subscribe directly; a stale one-shot listener must never consume another chat's render.
listen('CHARACTER_MESSAGE_RENDERED', index => liveMessage(index, true));
listen('MESSAGE_UPDATED', index => liveMessage(index));
listen('MESSAGE_SWIPED', index => liveMessage(index));
listen('CHAT_CHANGED', () => { reset(); void synchronize(); });
listen('CHAT_RENAMED', event => {
    if (!settings().enabled || !event) return;
    const ctx = getContext();
    const saved = ctx.chatMetadata?.[MODULE]?.servers?.[normalizeRoot(settings().apiRoot)];
    const bare = name => String(name || '').replace(/\.jsonl$/, '');
    if (saved && bare(saved.chat_id) === bare(event.oldFileName) && bare(ctx.chatId) === bare(event.newFileName)) {
        saved.chat_id = ctx.chatId;
        void ctx.saveMetadata?.();
        void synchronize();
    }
});
listen('GROUP_MEMBER_DRAFTED', member => {
    generationController?.abort();
    generationSequence++;
    clearPrompt();
    bridge.drafted = member;
    void synchronize();
});
listen('CHARACTER_EDITED', () => { if (settings().syncCards) void synchronize(); });
listen('PERSONA_CHANGED', () => { reset(); void synchronize(); });
function blockTranscript() {
    if (!settings().enabled) return;
    clearPrompt();
    generationController?.abort();
    try {
        const scope = currentScope();
        // All perspectives share the changed transcript; none may reuse cached knowledge.
        for (const data of Object.values(scope.saved.runtimes)) {
            data.blocked = 'Transcript removal needs AIOS retraction support. Start a new chat to continue AIOS synchronization.';
        }
        for (const runtime of bridge.live.values()) {
            runtime.cache = null;
            runtime.hudController?.abort();
            runtime.blocked = 'Transcript removal needs AIOS retraction support. Start a new chat to continue AIOS synchronization.';
        }
        bridge.block(scope, scope.data.blocked);
    } catch (error) { report(error); }
}
listen('MESSAGE_DELETED', blockTranscript);
listen('MESSAGE_SWIPE_DELETED', blockTranscript);
listen('CHAT_DELETED', () => reset());
listen('WORLD_INFO_ACTIVATED', entries => { lastLore = structuredClone(entries || []); });
listen('GENERATION_STOPPED', () => { generationController?.abort(); clearPrompt(); });
listen('GENERATION_ENDED', () => { generationController?.abort(); });

window[`${MODULE}_Intercept`] = async function (_chat, _contextSize, _abort, type) {
    clearPrompt();
    if (!settings().enabled || ['quiet', 'impersonate'].includes(type)) return;
    generationController?.abort();
    const controller = new AbortController();
    generationController = controller;
    const sequence = ++generationSequence;
    const timer = setTimeout(() => controller.abort(), Math.max(50, settings().generationBudgetMs));
    let onAbort;
    try {
        const scope = currentScope();
        const cancelled = new Promise(resolve => {
            onAbort = () => resolve(null);
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const hud = await Promise.race([bridge.generationHud(scope, controller.signal), cancelled]);
        if (!hud || sequence !== generationSequence || controller.signal.aborted || !bridge.current(scope) ||
            scope.live.blocked || !exactHud(hud, scope.data, scope.data.source_head_node_id)) return;
        const text = settings().tagWrapper
            ? `<aios_hud>\nAIOS runtime context for the active character; character/world state and retrieved knowledge, not user dialogue.\n\n${hud.text}\n</aios_hud>`
            : hud.text;
        setExtensionPrompt(MODULE, text, settings().position ?? extension_prompt_types.IN_PROMPT, settings().depth);
    } catch (error) { report(error); }
    finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        if (generationController === controller) generationController = null;
    }
};

function registerRecall() {
    const ctx = getContext();
    ctx.unregisterFunctionTool?.('aios_recall');
    if (!settings().nativeRecall || !ctx.registerFunctionTool) return;
    ctx.registerFunctionTool({
        name: 'aios_recall', displayName: 'Search AIOS memory',
        description: 'Search knowledge already acquired by this character instance. Use a short keyword or phrase. Does not research new sources.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Short memory keyword or phrase' } }, required: ['query'] },
        shouldRegister: () => settings().enabled && settings().nativeRecall && Boolean(getContext().isToolCallingSupported?.()),
        action: async ({ query }) => {
            try {
                const scope = currentScope();
                const result = await bridge.recall(scope, query);
                if (currentScope().key !== scope.key) throw new Error('The active character changed during recall');
                return JSON.stringify(result);
            }
            catch (error) { return JSON.stringify({ error: error.message }); }
        },
        formatMessage: () => 'Searching character memory…',
    });
}
async function runControl(work) {
    if (operationBusy) return;
    operationBusy = true;
    const buttons = [...document.querySelectorAll('#mvi_controls button')];
    buttons.forEach(button => { button.disabled = true; });
    let scope;
    try {
        scope = currentScope();
        const result = await work(scope);
        if (bridge.current(scope) && currentScope().key === scope.key) show('mvi_result', result);
    } catch (error) { if (!scope || bridge.current(scope)) { report(error); show('mvi_result', error.message); } }
    finally { operationBusy = false; buttons.forEach(button => { button.disabled = false; }); }
}
function input(id) { return String(el(id)?.value || '').trim(); }
function dossierId() {
    const value = input('mvi_dossier');
    if (!value) throw new Error('Select a research dossier first');
    return encodeURIComponent(value);
}
function renderDossiers(scope, data) {
    if (!bridge.current(scope)) return;
    const select = el('mvi_dossier');
    const old = select.value;
    select.replaceChildren();
    for (const dossier of data.dossiers || []) {
        const option = document.createElement('option');
        option.value = dossier.dossier_id;
        option.textContent = `${dossier.status}: ${dossier.question}`;
        select.append(option);
    }
    if ([...select.options].some(option => option.value === old)) select.value = old;
    else if (scope.data.last_research?.dossier_id) select.value = scope.data.last_research.dossier_id;
    show('mvi_dossiers', `${data.dossiers?.length || 0} dossiers. Discovery does not mean durable knowledge.`);
}
async function inspectDossier(scope) {
    const result = await bridge.feature(scope, `research/${dossierId()}`);
    if (bridge.current(scope)) {
        const sources = el('mvi_sources');
        sources.replaceChildren();
        for (const source of result.sources || []) {
            const label = document.createElement('label');
            label.style.display = 'block';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = source.section_id;
            checkbox.disabled = ['submitted', 'ingested'].includes(source.status) || ['submitted', 'ingested'].includes(source.materialization_status);
            label.append(checkbox, document.createTextNode(` ${source.title || source.heading || source.section_id}: ${source.excerpt || ''}`));
            sources.append(label);
        }
    }
    return result;
}
async function notify(scope, eventType, payload, externalId = uuid()) {
    const key = 'memoryvaultingest';
    await bridge.feature(scope, '/agent/integrations', { method: 'POST', body: {
        integration_key: key, integration_type: 'sillytavern', display_name: 'MemoryVaultIngest',
        capabilities: ['lifecycle_events'], config: { client_version: VERSION },
    } });
    return bridge.feature(scope, `/agent/integrations/${key}/event`, { method: 'POST', body: {
        external_event_id: externalId, instance_id: scope.data.instance_id, event_type: eventType, payload,
    } });
}
async function importResource(scope, { text, title, sourceId }) {
    if (!text.trim()) throw new Error('Choose a UTF-8 text file or paste resource text');
    if (text.length > 2_000_000) throw new Error('Resource is too large; import up to 2 million characters at a time');
    return bridge.feature(scope, '/corpus/document', { method: 'POST', body: {
        text, title, source_id: sourceId, source_kind: 'document', source_uri: null,
        meta: { client: MODULE, conversation_key: scope.saved.conversationKey,
            character_id: scope.data.character_id, identity_binding: 'external' },
    } });
}
async function initialize() {
    if (panelReady) return;
    panelReady = true;
    try {
        const html = await renderExtensionTemplateAsync('third-party/MemoryVaultIngest', 'settings');
        $('#extensions_settings2').append(html);
        const s = settings();
        el('mvi_api_root').value = s.apiRoot;
        const controls = { mvi_enabled: 'enabled', mvi_cached_hud: 'useCachedHud', mvi_reconcile: 'reconcileOnChatLoad',
            mvi_log_hud: 'logHudText', mvi_tag: 'tagWrapper', mvi_sync_cards: 'syncCards', mvi_native_recall: 'nativeRecall' };
        for (const [id, key] of Object.entries(controls)) {
            el(id).checked = s[key];
            el(id).addEventListener('change', () => {
                s[key] = el(id).checked;
                saveSettingsDebounced();
                if (key === 'nativeRecall') registerRecall();
                if (key === 'enabled') { reset(); if (s.enabled) void synchronize(); }
            });
        }
        for (const [id, key] of Object.entries({ mvi_depth: 'depth', mvi_recent_limit: 'recentLimit', mvi_token_budget: 'tokenBudget',
            mvi_prepare_wait: 'prepareWaitMs', mvi_generation_budget: 'generationBudgetMs' })) {
            el(id).value = s[key];
            el(id).addEventListener('change', () => {
                const value = Number(el(id).value);
                s[key] = Number.isFinite(value) ? Math.max(Number(el(id).min || 0), Math.min(Number(el(id).max || Infinity), value)) : defaults[key];
                el(id).value = s[key];
                saveSettingsDebounced();
                for (const runtime of bridge.live.values()) runtime.cache = null;
            });
        }
        document.querySelectorAll('input[name="mvi_position"]').forEach(radio => {
            radio.checked = Number(radio.value) === s.position;
            radio.addEventListener('change', () => { s.position = Number(radio.value); saveSettingsDebounced(); clearPrompt(); });
        });
        el('mvi_connect').addEventListener('click', async () => {
            try { s.apiRoot = normalizeRoot(input('mvi_api_root')); } catch (error) { report(error); return; }
            el('mvi_api_root').value = s.apiRoot;
            saveSettingsDebounced(); reset(); await probe(); await synchronize();
        });
        const bind = (id, work) => el(id).addEventListener('click', () => void runControl(work));
        bind('mvi_refresh', async scope => { const state = await bridge.refreshState(scope); void bridge.prefetch(scope); return state; });
        bind('mvi_sync_identity', scope => scope.live.queue.run(() => bridge.syncIdentity(scope, { force: true })));
        bind('mvi_stage_identity', scope => scope.live.queue.run(() => bridge.syncIdentity(scope, { staged: true })));
        bind('mvi_replace_identity', scope => scope.live.queue.run(() => bridge.syncIdentity(scope, { replace: true })));
        for (const decision of ['accept', 'reject']) bind(`mvi_identity_${decision}`, scope => {
            const candidate = input('mvi_candidate');
            if (!candidate) throw new Error('Enter a candidate ID from the identity inspection');
            bridge.invalidate(scope);
            return bridge.feature(scope, `/character/${encodeURIComponent(scope.data.character_id)}/identity/candidate/${encodeURIComponent(candidate)}/${decision}`, {
                method: 'POST', body: { actor: 'sillytavern_operator', reason: input('mvi_identity_reason') || null },
            });
        });
        bind('mvi_identity', scope => bridge.feature(scope, `/character/${encodeURIComponent(scope.data.character_id)}/identity`));
        bind('mvi_recall', scope => bridge.recall(scope, input('mvi_query')));
        bind('mvi_research_list', async scope => { const data = await bridge.feature(scope, 'research'); renderDossiers(scope, data); return data; });
        bind('mvi_research_open', async scope => {
            const question = input('mvi_question');
            if (question.length < 3 || question.length > 600) throw new Error('Enter a research question of 3–600 characters');
            const result = await bridge.feature(scope, 'research', { method: 'POST', body: { question } });
            renderDossiers(scope, await bridge.feature(scope, 'research'));
            if (bridge.current(scope) && result.dossier_id) el('mvi_dossier').value = result.dossier_id;
            return result;
        });
        bind('mvi_research_inspect', inspectDossier);
        bind('mvi_research_advance', async scope => {
            const result = await bridge.researchStep(scope, input('mvi_dossier') || dossierId(), 'advance', { include_fanwork: false });
            await inspectDossier(scope); return result;
        });
        bind('mvi_research_study', async scope => {
            const section_ids = [...document.querySelectorAll('#mvi_sources input:checked')].map(node => node.value);
            if (section_ids.length < 1 || section_ids.length > 2) throw new Error('Select one or two exposed source sections');
            const result = await bridge.researchStep(scope, input('mvi_dossier') || dossierId(), 'study', { section_ids });
            await inspectDossier(scope); return result;
        });
        bind('mvi_research_question', scope => {
            const question = input('mvi_question');
            if (question.length < 3 || question.length > 600) throw new Error('Enter a follow-up question of 3–600 characters');
            return bridge.feature(scope, `research/${dossierId()}/question`, { method: 'POST', body: { question } });
        });
        for (const status of ['paused', 'open', 'closed']) bind(status === 'open' ? 'mvi_research_resume' : `mvi_research_${status}`, scope =>
            bridge.feature(scope, `research/${dossierId()}/status`, { method: 'POST', body: { status } }));
        el('mvi_dossier').addEventListener('change', () => show('mvi_sources', 'Inspect this dossier to select its sources.'));
        bind('mvi_resource_import', async scope => {
            const file = el('mvi_resource_file').files?.[0];
            if (file?.size > 4_000_000) throw new Error('Choose a text file smaller than 4 MB');
            const text = file ? await file.text() : el('mvi_resource_text').value;
            const title = input('mvi_resource_title') || file?.name || 'SillyTavern resource';
            return importResource(scope, { text, title, sourceId: `sillytavern:${scope.saved.conversationKey}:resource:${await digest(title)}` });
        });
        bind('mvi_lore_import', async scope => {
            if (!lastLore.length) throw new Error('No activated lore captured yet; generate a reply first');
            const entries = structuredClone(lastLore);
            const results = [];
            for (const entry of entries) {
                if (!entry.content?.trim()) continue;
                results.push(await importResource(scope, { text: entry.content, title: entry.comment || `Lore ${entry.uid}`,
                    sourceId: `sillytavern:${scope.saved.conversationKey}:lore:${entry.world || 'book'}:${entry.uid ?? await digest(entry.content)}` }));
            }
            return { imported: results.length, documents: results, knowledge_acquired: false };
        });
        bind('mvi_wake', scope => notify(scope, 'USER_ATTENTION', { message: input('mvi_objective') || 'User requested attention from SillyTavern' }));
        bind('mvi_task', scope => {
            const objective = input('mvi_objective');
            if (!objective) throw new Error('Enter a task objective');
            return bridge.feature(scope, 'task', { method: 'POST', body: { task_type: input('mvi_task_type'), objective } });
        });
        bind('mvi_action', async scope => {
            const state = await bridge.refreshState(scope);
            const action_type = input('mvi_action_type');
            const target_entity_id = input('mvi_action_target') || null;
            if (action_type === 'move' && !target_entity_id) throw new Error('Move requires an existing location entity ID');
            const result = await bridge.feature(scope, `/instance/${scope.data.instance_id}/action`, { method: 'POST', body: {
                expected_state_version: state.state_version, action_type, target_entity_id,
                text: input('mvi_action_text') || null, payload: { source: 'SillyTavern', operator_requested: true },
            } });
            bridge.invalidate(scope);
            scope.data.state_version = result.state_version;
            await bridge.save(scope);
            void bridge.prefetch(scope);
            return result;
        });
        el('mvi_independent').addEventListener('click', async () => {
            if (operationBusy || !settings().enabled) return;
            try {
                const ctx = getContext();
                if (!ctx.chatMetadata) throw new Error('Open a chat first');
                const root = normalizeRoot(settings().apiRoot);
                const all = ctx.chatMetadata[MODULE] ||= { version: 2, servers: {} };
                all.servers ||= {};
                const saved = all.servers[root];
                if (!saved || (String(saved.chat_id) === String(ctx.chatId) && String(saved.group_id ?? '') === String(ctx.groupId ?? ''))) {
                    throw new Error('This control is only for a copied chat with an inherited AIOS mapping.');
                }
                all.servers[root] = { conversationKey: `chat:${uuid()}`, chat_id: ctx.chatId, group_id: ctx.groupId ?? null, runtimes: {},
                    parent_conversation_key: saved.conversationKey };
                reset();
                await ctx.saveMetadata?.();
                await synchronize();
            } catch (error) { report(error); }
        });
        bind('mvi_versions', scope => bridge.feature(scope, '/agent/runtime/versions'));
        bind('mvi_atlas', scope => bridge.feature(scope, '/agent/knowledge-atlas/health'));
        registerRecall();
        monitor = setInterval(() => void probe(), 15000);
        await probe();
        await synchronize();
    } catch (error) { panelReady = false; report(error); }
}
jQuery(() => void initialize());
window.addEventListener('beforeunload', () => { clearInterval(monitor); bridge.reset(); });
console.log(`[${MODULE}] v${VERSION} loaded`);
