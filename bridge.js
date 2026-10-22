// Transport-independent AIOS client. No SillyTavern imports: exercised with mock HTTP.
export const MODULE = 'MemoryVaultIngest';
export const VERSION = '0.9.1';
export const defaults = {
    enabled: true, apiRoot: 'http://192.168.1.217:8000', position: 1, depth: 1,
    recentLimit: 12, tokenBudget: 4000, prepareWaitMs: 1200, generationBudgetMs: 900,
    requestTimeoutMs: 10000, maxRetries: 1, retryDelayMs: 250,
    hudReadinessAttempts: 3, hudReadinessRetryDelayMs: 500,
    useCachedHud: true, tagWrapper: true,
    reconcileOnChatLoad: true, logHudText: true, syncCards: true, nativeRecall: false,
};
export function normalizeRoot(value) {
    let root = String(value || defaults.apiRoot).trim();
    if (!/^https?:\/\//i.test(root)) root = `http://${root}`;
    const parsed = new URL(root);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('AIOS URL must use HTTP or HTTPS');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use an AIOS base URL without credentials, query, or fragment');
    return root.replace(/\/+$/, '');
}
export const hasGroup = ctx => ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId) !== '';
export const normalizeId = name => String(name || '').trim().replace(/\s+/g, '_');
// LAN-hosted SillyTavern may run over HTTP, where randomUUID/subtle are absent.
export const uuid = (provider = globalThis.crypto) => {
    if (provider.randomUUID) return provider.randomUUID();
    const bytes = provider.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export function sha256(bytes) {
    const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
    padded.set(bytes); padded[bytes.length] = 128;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
    const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const rotate = (x, n) => (x >>> n) | (x << (32 - n));
    const words = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++) {
            const x = words[i - 15], y = words[i - 2];
            words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
        }
        let [a,b,c,d,e,f,g,h] = state;
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
            const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
        }
        [a,b,c,d,e,f,g,h].forEach((value, i) => { state[i] = (state[i] + value) >>> 0; });
    }
    return state.map(x => x.toString(16).padStart(8, '0')).join('');
}
export async function digest(value) {
    const input = new TextEncoder().encode(value);
    if (!globalThis.crypto?.subtle) return sha256(input);
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', input);
    return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export class SerialQueue {
    tail = Promise.resolve();
    run(work) {
        const result = this.tail.then(work);
        this.tail = result.catch(() => {});
        return result;
    }
}
export function selectedCard(ctx, message = null, drafted = null) {
    const characters = ctx.characters || [];
    if (message && !message.is_user) {
        if (message.original_avatar) {
            const found = characters.find(c => c.avatar === message.original_avatar);
            if (found) return found;
        }
        const matches = characters.filter(c => (c.name || c.data?.name) === message.name);
        if (matches.length === 1) return matches[0];
        if (hasGroup(ctx)) throw new Error('Cannot uniquely identify the group message speaker');
    }
    if (hasGroup(ctx) && drafted != null) {
        const found = characters[drafted] || characters.find(c => c.avatar === drafted);
        if (found) return found;
    }
    if (ctx.characterId != null && characters[ctx.characterId]) return characters[ctx.characterId];
    if (hasGroup(ctx)) {
        const group = (ctx.groups || []).find(g => String(g.id) === String(ctx.groupId));
        const members = characters.filter(c => group?.members?.includes(c.avatar));
        if (members.length === 1) return members[0];
        throw new Error('Select the responding group member before using AIOS controls');
    }
    // Name-only fallback preserves compatibility with older clients.
    if (ctx.name2) return { name: ctx.name2, data: { name: ctx.name2 } };
    throw new Error('Open a character chat first');
}
export function authoredCard(card) {
    const data = card.data || card;
    return {
        name: data.name || card.name,
        description: data.description || card.description || '',
        personality: data.personality || card.personality || '',
        mes_example: data.mes_example || card.mes_example || '',
        extensions: { aios: data.extensions?.aios || {} },
    };
}
export function receiptHead(receipt, previous = null) {
    if (Object.hasOwn(receipt, 'source_head_node_id')) {
        return receipt.source_head_node_id || (receipt.source_current === false ? previous : receipt.node_id) || previous;
    }
    return receipt.source_current === false ? previous : receipt.node_id || previous;
}
export function exactHud(cache, runtime, head) {
    return Boolean(head && cache?.generation_ready && cache.instance_id === runtime.instance_id && cache.node === head);
}
export class AIOSBridge {
    // Native browser fetch requires Window as its receiver (not this bridge).
    constructor({ getContext, settings, fetchImpl = globalThis.fetch.bind(globalThis), onChange = () => {} }) {
        Object.assign(this, { getContext, settings, fetchImpl, onChange });
        this.live = new Map();
        this.connections = new SerialQueue();
        this.drafted = null;
        this.epoch = 0;
        this.controllers = new Set();
    }
    reset() {
        this.epoch++;
        this.drafted = null;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
        this.live.clear();
        this.onChange({ state: 'DISCONNECTED' });
    }
    async request(root, path, { method = 'GET', body, signal, timeoutMs, retries = 0 } = {}) {
        for (let attempt = 0; ; attempt++) {
            const controller = new AbortController();
            this.controllers.add(controller);
            const forward = () => controller.abort(signal.reason);
            if (signal?.aborted) forward();
            else signal?.addEventListener('abort', forward, { once: true });
            const timer = setTimeout(() => controller.abort(new DOMException('AIOS request timed out', 'TimeoutError')),
                Math.max(1, timeoutMs ?? this.settings().requestTimeoutMs));
            try {
                const response = await this.fetchImpl(root + path, {
                    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
                    body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
                });
                if (!response.ok) {
                    const error = new Error(`AIOS HTTP ${response.status}: ${(await response.text()).slice(0, 1500)}`);
                    error.status = response.status;
                    throw error;
                }
                return await response.json();
            } catch (error) {
                if (controller.signal.aborted || signal?.aborted || attempt >= retries ||
                    (error.status && error.status < 500)) throw error;
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', forward);
                this.controllers.delete(controller);
            }
        }
    }
    scope(ctx = this.getContext(), card = selectedCard(ctx, null, this.drafted)) {
        if (!this.settings().enabled) throw new Error('Enable MemoryVaultIngest first');
        const root = normalizeRoot(this.settings().apiRoot);
        const characterId = card.data?.extensions?.[MODULE]?.character_id ||
            this.settings().characterIds?.[card.avatar] || normalizeId(card.name || card.data?.name);
        if (!characterId) throw new Error('The selected character has no identity');
        if (!ctx.chatMetadata) throw new Error('Chat metadata is not available');
        const metadata = ctx.chatMetadata;
        const all = metadata[MODULE] ||= { version: 2, servers: {} };
        all.servers ||= {};
        const saved = all.servers[root] ||= {
            conversationKey: hasGroup(ctx)
                ? `group:${ctx.groupId}:chat:${ctx.chatId || uuid()}`
                : `chat:${ctx.chatId || uuid()}`,
            runtimes: {},
        };
        if ((saved.chat_id !== undefined && String(saved.chat_id) !== String(ctx.chatId)) ||
            (saved.group_id !== undefined && String(saved.group_id ?? '') !== String(ctx.groupId ?? ''))) {
            throw new Error('This chat inherited another chat’s AIOS mapping. Use “Connect copied chat independently” to replay it in a new session.');
        }
        saved.chat_id = ctx.chatId;
        saved.group_id = ctx.groupId ?? null;
        saved.runtimes ||= {};
        saved.user_name ||= ctx.name1 || 'User';
        const runtimeKey = `${characterId}::${saved.user_name}`;
        const data = saved.runtimes[runtimeKey] ||= { character_id: characterId, user_name: saved.user_name, receipts: {}, operations: {} };
        data.receipts ||= {};
        data.operations ||= {};
        if (data.user_name === characterId) throw new Error('Human and character AIOS IDs must be distinct');
        const key = `${root}::${saved.conversationKey}::${runtimeKey}`;
        if (!this.live.has(key)) this.live.set(key, { queue: new SerialQueue(), cache: null, prefetch: null, blocked: data.blocked || null });
        return { ctx, card, root, metadata, saved, data, key, live: this.live.get(key), epoch: this.epoch,
            sourceSession: hasGroup(ctx) ? `${saved.conversationKey}:view:${characterId}` : saved.conversationKey };
    }
    current(scope) {
        return scope.epoch === this.epoch && scope.metadata === this.getContext().chatMetadata &&
            scope.root === normalizeRoot(this.settings().apiRoot) && this.settings().enabled;
    }
    assertCurrent(scope) {
        if (!this.current(scope)) throw new DOMException('AIOS chat changed', 'AbortError');
        if (scope.live.blocked) throw new Error(scope.live.blocked);
    }
    async save(scope) {
        if (this.current(scope)) await scope.ctx.saveMetadata?.();
    }
    invalidate(scope) {
        scope.live.cache = null;
        scope.live.hudRevision = (scope.live.hudRevision || 0) + 1;
        scope.live.hudController?.abort();
        scope.live.prefetch = null;
    }
    status(scope, state, detail = {}) {
        if (this.current(scope)) this.onChange({ state, character_id: scope.data.character_id, ...detail });
    }
    async syncIdentity(scope, { replace = false, staged = false, force = false, signal } = {}) {
        this.assertCurrent(scope);
        const card = authoredCard(scope.card);
        const hash = await digest(JSON.stringify(card));
        if (!force && !replace && !staged && scope.data.card_hash === hash) return { unchanged: true };
        const result = await this.request(scope.root, `/character/${encodeURIComponent(scope.data.character_id)}/identity/bootstrap/card`, {
            method: 'POST', body: { card, source_name: 'SillyTavern', source_format: 'character_card',
                replace_authored_facets: replace, auto_accept_authored: !staged }, signal,
        });
        this.assertCurrent(scope);
        scope.data.card_hash = hash;
        scope.data.identity_staged = staged;
        this.invalidate(scope);
        scope.data.identity_version = result.identity_version;
        await this.save(scope);
        return result;
    }
    connect(scope, options = {}) {
        return this.connections.run(() => this.connectRuntime(scope, options));
    }
    async connectRuntime(scope, { signal } = {}) {
        this.assertCurrent(scope);
        if (!scope.data.session_id) {
            const session = await this.request(scope.root, '/session', { method: 'POST', signal, body: {
                source: 'SillyTavern', source_session_id: scope.sourceSession,
                topic: `${scope.data.character_id}-${scope.saved.conversationKey}`,
                meta: { character_id: scope.data.character_id, user_name: scope.data.user_name,
                    chat_id: scope.ctx.chatId, group_id: scope.ctx.groupId ?? null, client_version: VERSION },
            } });
            this.assertCurrent(scope);
            scope.data.session_id = session.session_id;
            await this.save(scope);
        }
        if (this.settings().syncCards) await this.syncIdentity(scope, { signal });
        if (!scope.data.instance_id || !scope.live.activated) {
            const activation = await this.request(scope.root, `/character/${encodeURIComponent(scope.data.character_id)}/activate`, {
                method: 'POST', signal, body: { session_id: scope.data.session_id, user_name: scope.data.user_name,
                    scope_key: 'conversation', ...(scope.saved.world_id ? { world_id: scope.saved.world_id } : {}),
                    controller_type: 'agent', controller_ref: `sillytavern:${scope.data.character_id}` },
            });
            this.assertCurrent(scope);
            Object.assign(scope.data, activation);
            scope.saved.world_id = activation.world_id;
            scope.live.activated = true;
            // A persisted instance is a hint; the server resolves activation on reconnect.
            const state = await this.request(scope.root, `/instance/${encodeURIComponent(scope.data.instance_id)}/state`, { signal });
            this.assertCurrent(scope);
            scope.data.source_head_node_id = state.source_head_node_id || null;
            scope.data.source_timeline_id = state.source_timeline_id || null;
            scope.data.state_version = state.state_version;
            await this.save(scope);
        }
        this.status(scope, 'RUNTIME_ACTIVE', { instance_id: scope.data.instance_id });
        return scope.data;
    }
    async ingest(scope, index, message, { dispatchResearch = false, signal } = {}) {
        if (!message?.mes || message.is_system) return null;
        this.assertCurrent(scope);
        await this.connect(scope, { signal });
        const human = Boolean(message.is_user || message.sender === 'user');
        const speakerCard = human ? null : selectedCard(scope.ctx, message, this.drafted);
        const speaker = human ? scope.data.user_name :
            speakerCard.data?.extensions?.[MODULE]?.character_id || this.settings().characterIds?.[speakerCard.avatar] || normalizeId(speakerCard.name || speakerCard.data?.name);
        const prior = scope.data.receipts[index];
        if (prior?.message_uuid && message[MODULE]?.message_id !== prior.message_uuid) {
            this.block(scope, 'Transcript slots changed. AIOS retraction support is required; start a new chat.');
            throw new Error(scope.live.blocked);
        }
        const textHash = await digest(message.mes);
        this.assertCurrent(scope);
        const receipt = await this.request(scope.root, '/ingest', { method: 'POST', signal,
            retries: Number(this.settings().maxRetries || 0), body: {
                session_id: scope.data.session_id, character_id: scope.data.character_id, user_name: scope.data.user_name,
                speaker_id: speaker, speaker_type: human ? 'user' : 'character', viewpoint_id: speaker,
                recipient_id: hasGroup(scope.ctx) ? null : human ? scope.data.character_id : scope.data.user_name,
                text: message.mes, kind: 'chat_message', scope_key: 'conversation',
                payload: { source: 'SillyTavern', chat_id: scope.ctx.chatId, group_id: scope.ctx.groupId ?? null,
                    message_id: index, client_message_id: message[MODULE]?.message_id, swipe_id: message.swipe_id ?? message.swipeId ?? null,
                    speaker_name: message.name, original_avatar: message.original_avatar ?? null,
                    send_date: message.send_date ?? null, gen_started: message.gen_started ?? null,
                    gen_finished: message.gen_finished ?? null, model: message.extra?.model ?? null,
                    api: message.extra?.api ?? null,
                    evidence_correlation_key: `sillytavern:${scope.saved.conversationKey}:${index}:${textHash}` },
            } });
        this.assertCurrent(scope);
        scope.data.receipts[index] = { ...receipt, text_hash: textHash, speaker_id: speaker, message_uuid: message[MODULE]?.message_id };
        scope.data.source_head_node_id = receiptHead(receipt, scope.data.source_head_node_id);
        scope.data.source_timeline_id = receipt.timeline_id || scope.data.source_timeline_id;
        await this.save(scope);
        if (dispatchResearch && !human && speaker === scope.data.character_id && receipt.source_current !== false &&
            /<aios_action>[\s\S]*?<\/aios_action>/i.test(message.mes)) {
            try {
                const result = await this.request(scope.root, `/agent/instance/${scope.data.instance_id}/research/tool-request`, {
                    method: 'POST', body: { source_node_id: receipt.node_id }, signal, timeoutMs: 15000,
                });
                this.assertCurrent(scope);
                scope.data.last_research = result;
                await this.save(scope);
            } catch (error) { this.status(scope, 'RESEARCH_ERROR', { error: error.message }); }
        }
        return receipt;
    }
    // Snapshot before enqueueing so edits after an event do not mutate its request.
    stamp(message) {
        if (!message?.mes || message.is_system) return;
        message[MODULE] ||= {};
        message[MODULE].message_id ||= uuid();
    }
    submit(scope, index, message, options = {}) {
        this.stamp(message);
        const copy = structuredClone(message);
        return scope.live.queue.run(async () => {
            this.assertCurrent(scope);
            await scope.ctx.saveChat?.();
            return this.ingest(scope, index, copy, options);
        });
    }
    reconcile(scope) {
        for (const message of scope.ctx.chat || []) this.stamp(message);
        const chat = structuredClone(scope.ctx.chat || []);
        return scope.live.queue.run(async () => {
            this.assertCurrent(scope);
            this.status(scope, 'SYNCING');
            await scope.ctx.saveChat?.();
            await this.connect(scope);
            // Positional slots cannot safely express removals or reordered messages.
            if (Object.keys(scope.data.receipts).some(index => !chat[Number(index)]?.mes || chat[Number(index)].is_system ||
                (scope.data.receipts[index].message_uuid && scope.data.receipts[index].message_uuid !== chat[Number(index)][MODULE]?.message_id))) {
                this.block(scope, 'Transcript removal needs AIOS retraction support. Start a new chat to continue AIOS synchronization.');
                throw new Error(scope.live.blocked);
            }
            for (let index = 0; index < chat.length; index++) await this.ingest(scope, index, chat[index]);
            return scope.data.source_head_node_id;
        });
    }
    block(scope, reason) {
        scope.live.blocked = reason;
        scope.data.blocked = reason;
        scope.live.cache = null;
        scope.live.hudController?.abort();
        void this.save(scope);
        this.status(scope, 'SYNC_BLOCKED', { error: reason });
    }
    async refreshState(scope) {
        return scope.live.queue.run(async () => {
            this.assertCurrent(scope);
            await this.connect(scope);
            const state = await this.request(scope.root, `/instance/${scope.data.instance_id}/state`);
            this.assertCurrent(scope);
            scope.data.source_head_node_id = state.source_head_node_id || null;
            scope.data.source_timeline_id = state.source_timeline_id || null;
            scope.data.state_version = state.state_version;
            this.invalidate(scope);
            await this.save(scope);
            return state;
        });
    }
    prefetch(scope) {
        if (!this.current(scope) || scope.live.blocked) return Promise.resolve(null);
        const node = scope.data.source_head_node_id;
        if (!node) return Promise.resolve(null);
        if (scope.live.prefetch?.node === node) return scope.live.prefetch.promise;
        scope.live.hudController?.abort();
        const controller = new AbortController();
        scope.live.hudController = controller;
        const promise = this.prepareHud(scope, node, controller.signal).catch(error => {
            if (error.name !== 'AbortError') this.status(scope, 'DEGRADED', { error: error.message });
            return null;
        }).finally(() => {
            if (scope.live.prefetch?.promise === promise) scope.live.prefetch = null;
        });
        scope.live.prefetch = { node, promise };
        return promise;
    }
    async prepareHud(scope, node, signal) {
        const revision = scope.live.hudRevision || 0;
        const settings = this.settings();
        const params = new URLSearchParams({ through_node_id: node,
            recent_limit: String(Math.max(1, settings.recentLimit)), token_budget: String(Math.max(256, settings.tokenBudget)),
            wait_ms: String(Math.max(0, Math.min(10000, settings.prepareWaitMs))) });
        const attempts = Math.max(1, settings.hudReadinessAttempts);
        for (let attempt = 0; attempt < attempts; attempt++) {
            this.assertCurrent(scope);
            this.status(scope, 'HUD_PREPARING', { node });
            const result = await this.request(scope.root, `/instance/${scope.data.instance_id}/hud?${params}`, {
                method: 'POST', signal, timeoutMs: Math.max(8000, settings.requestTimeoutMs, settings.prepareWaitMs + 3000),
            });
            this.assertCurrent(scope);
            if (signal?.aborted || scope.data.source_head_node_id !== node || (scope.live.hudRevision || 0) !== revision) return null;
            if (result.generation_ready && result.text?.trim()) {
                scope.live.cache = { ...result, node };
                this.status(scope, 'READY', { freshness: result.freshness, frame: result.frame, node });
                if (settings.logHudText) console.debug(`[${MODULE}] AIOS HUD prompt returned:\n${result.text}`);
                return scope.live.cache;
            }
            this.status(scope, 'HUD_WAITING', { freshness: result.freshness, node });
            if (attempt + 1 < attempts) await new Promise((resolve, reject) => {
                const cancel = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
                const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, settings.hudReadinessRetryDelayMs * (attempt + 1));
                if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
            });
        }
        return null;
    }
    async generationHud(scope, signal) {
        this.assertCurrent(scope);
        await scope.live.queue.tail;
        this.assertCurrent(scope);
        if (signal.aborted) return null;
        const node = scope.data.source_head_node_id;
        if (this.settings().useCachedHud && exactHud(scope.live.cache, scope.data, node)) return scope.live.cache;
        const result = await this.prefetch(scope);
        this.assertCurrent(scope);
        return !signal.aborted && exactHud(result, scope.data, scope.data.source_head_node_id) ? result : null;
    }
    async feature(scope, suffix, { method = 'GET', body, timeoutMs } = {}) {
        return scope.live.queue.run(async () => {
            this.assertCurrent(scope);
            await this.connect(scope);
            const path = suffix.startsWith('/') ? suffix : `/agent/instance/${scope.data.instance_id}/${suffix}`;
            const result = await this.request(scope.root, path, { method, body, timeoutMs });
            this.assertCurrent(scope);
            return result;
        });
    }
    async recall(scope, query) {
        const text = String(query).trim();
        if (!text) throw new Error('Enter a short memory search term');
        return scope.live.queue.run(async () => {
            await this.connect(scope);
            const result = await this.request(scope.root, '/epistemic/search', { method: 'POST', body: {
                query: text.slice(0, 600), instance_id: scope.data.instance_id, limit: 8, include_conflicts: true,
            } });
            this.assertCurrent(scope);
            return result;
        });
    }
    async researchStep(scope, dossier, operation, values = {}) {
        if (!['advance', 'study'].includes(operation)) throw new Error('Unsupported research operation');
        // Store before sending. A timeout retries the SAME operation ID after reload.
        const key = `${dossier}:${operation}:${JSON.stringify(values)}`;
        const requestId = scope.data.operations[key] ||= uuid();
        await this.save(scope);
        const result = await this.feature(scope, `research/${encodeURIComponent(dossier)}/${operation}`, {
            method: 'POST', body: { ...values, request_id: requestId }, timeoutMs: 30000,
        });
        const state = result.status || result.step?.status;
        if (!['pending', 'running', 'busy'].includes(state)) {
            delete scope.data.operations[key];
            await this.save(scope);
        }
        this.invalidate(scope);
        return result;
    }
}
