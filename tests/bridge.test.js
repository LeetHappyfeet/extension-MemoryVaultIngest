import test from 'node:test';
import assert from 'node:assert/strict';
import { AIOSBridge, MODULE, defaults, SerialQueue, receiptHead, exactHud, selectedCard, normalizeRoot } from '../bridge.js';

const clone = value => structuredClone(value);
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });
function fixture(options = {}) {
    let context = {
        name1: 'Mia', name2: 'Renamon', characterId: 0, groupId: null, chatId: 'chat-a', chatMetadata: {},
        characters: [{ name: 'Renamon', avatar: 'renamon.png', data: { name: 'Renamon', description: 'A fox', personality: 'Calm', scenario: 'Kitchen', first_mes: 'Hello' } }],
        chat: [], saveMetadata: async () => {}, saveChat: async () => {},
    };
    const settings = { ...defaults, logHudText: false, retryDelayMs: 0, hudReadinessAttempts: 1 };
    const calls = [];
    let sequence = 0;
    let head = null;
    const states = new Map();
    const fetchImpl = async (url, init) => {
        const path = new URL(url).pathname;
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ path, body, method: init.method, signal: init.signal });
        if (options.handle) {
            const custom = await options.handle(path, body, init, calls);
            if (custom !== undefined) return custom;
        }
        if (path === '/session') return response({ session_id: `session-${++sequence}` });
        if (path.endsWith('/identity/bootstrap/card')) return response({ identity_version: 1, accepted_count: 3 });
        if (path.endsWith('/activate')) {
            const character_id = decodeURIComponent(path.split('/')[2]);
            const instance_id = `instance-${character_id}`;
            const value = { character_id, instance_id, entity_id: `entity-${character_id}`, world_id: body.world_id || `world-${++sequence}`, timeline_id: 'runtime-timeline', state_version: 1 };
            states.set(instance_id, value);
            return response(value);
        }
        if (path.endsWith('/state')) return response({ ...states.get(path.split('/')[2]), source_head_node_id: head });
        if (path === '/ingest') {
            head = `node-${++sequence}`;
            return response({ ok: true, node_id: head, source_head_node_id: head, source_current: true, disposition: 'new', event_id: sequence, timeline_id: 'source-timeline' });
        }
        if (path.endsWith('/hud')) return response({ instance_id: path.split('/')[2], generation_ready: true, text: 'Ready HUD', freshness: {}, frame: {} });
        return response({ results: [], status: 'completed' });
    };
    const bridge = new AIOSBridge({ getContext: () => context, settings: () => settings, fetchImpl });
    return { bridge, calls, settings, ctx: context, change: value => { context = value; }, scope: () => bridge.scope() };
}

test('receipt parsing preserves server head on historical replay and handles null/legacy heads', () => {
    assert.equal(receiptHead({ node_id: 'old', source_head_node_id: 'new', source_current: false }, 'prior'), 'new');
    assert.equal(receiptHead({ node_id: 'old', source_current: false }, 'prior'), 'prior');
    assert.equal(receiptHead({ node_id: 'old', source_head_node_id: null, source_current: false }, 'prior'), 'prior');
    assert.equal(receiptHead({ node_id: 'new' }, 'prior'), 'new');
});
test('HUD reuse requires readiness, instance, and exact non-null source boundary', () => {
    const cache = { instance_id: 'a', node: 'n', generation_ready: true };
    assert.ok(exactHud(cache, { instance_id: 'a' }, 'n'));
    assert.equal(exactHud(cache, { instance_id: 'b' }, 'n'), false);
    assert.equal(exactHud(cache, { instance_id: 'a' }, 'other'), false);
    assert.equal(exactHud({ ...cache, generation_ready: false }, { instance_id: 'a' }, 'n'), false);
    assert.equal(exactHud(cache, { instance_id: 'a' }, null), false);
});
test('queue remains serialized and recovers after a failed operation', async () => {
    const queue = new SerialQueue();
    const order = [];
    const first = queue.run(async () => { order.push(1); await new Promise(r => setTimeout(r, 5)); order.push(2); throw new Error('failure'); });
    const second = queue.run(() => { order.push(3); return 'ok'; });
    await assert.rejects(first, /failure/);
    assert.equal(await second, 'ok');
    assert.deepEqual(order, [1, 2, 3]);
});
test('card sync excludes transient fields, avoids duplicate imports, and supports staged decisions', async () => {
    const f = fixture(); const scope = f.scope();
    await scope.live.queue.run(() => f.bridge.connect(scope));
    await scope.live.queue.run(() => f.bridge.connect(scope));
    const imports = f.calls.filter(c => c.path.endsWith('/identity/bootstrap/card'));
    assert.equal(imports.length, 1);
    assert.equal(imports[0].body.replace_authored_facets, false);
    assert.equal(imports[0].body.auto_accept_authored, true);
    assert.equal(imports[0].body.card.scenario, undefined);
    assert.equal(imports[0].body.card.first_mes, undefined);
    f.ctx.characters[0].data.personality = 'Thoughtful';
    await f.bridge.syncIdentity(scope, { staged: true });
    await f.bridge.connect(scope);
    assert.equal(f.calls.filter(c => c.path.endsWith('/identity/bootstrap/card')).length, 2);
    assert.equal(f.calls.filter(c => c.path.endsWith('/identity/bootstrap/card'))[1].body.auto_accept_authored, false);
    await f.bridge.syncIdentity(scope, { force: true });
    assert.equal(f.calls.filter(c => c.path.endsWith('/identity/bootstrap/card'))[2].body.auto_accept_authored, true);
});
test('first submission preserves generation metadata, stable message UUID, and runtime coordinates', async () => {
    const f = fixture(); const scope = f.scope();
    const message = { mes: 'Hello', is_user: false, name: 'Renamon', send_date: '2026-10-22T00:00:00Z', gen_started: 1, gen_finished: 2, extra: { api: 'custom', model: 'Qwen', reasoning: 'must not forward' } };
    await f.bridge.submit(scope, 0, message);
    const request = f.calls.find(c => c.path === '/ingest').body;
    assert.equal(request.speaker_id, 'Renamon');
    assert.equal(request.viewpoint_id, 'Renamon');
    assert.equal(request.payload.model, 'Qwen');
    assert.equal(request.payload.api, 'custom');
    assert.equal(request.payload.send_date, message.send_date);
    assert.equal(request.payload.client_message_id, message[MODULE].message_id);
    assert.equal(JSON.stringify(request).includes('must not forward'), false);
    assert.equal(scope.data.world_id, scope.saved.world_id);
    assert.ok(scope.data.entity_id);
    assert.ok(scope.data.timeline_id);
    assert.equal(scope.data.receipts[0].node_id, scope.data.source_head_node_id);
});
test('replay uses current source head rather than historical acknowledged node', async () => {
    const f = fixture({ handle: path => path === '/ingest' ? response({ node_id: 'old', source_head_node_id: 'current', source_current: false, disposition: 'active_replay' }) : undefined });
    const scope = f.scope();
    await f.bridge.submit(scope, 0, { mes: 'Hi', is_user: true });
    assert.equal(scope.data.source_head_node_id, 'current');
    assert.equal(scope.data.receipts[0].node_id, 'old');
});
test('native recall always sends instance scope and bounded results', async () => {
    const f = fixture(); const scope = f.scope();
    await f.bridge.recall(scope, 'cook');
    assert.deepEqual(f.calls.find(c => c.path === '/epistemic/search').body, { query: 'cook', instance_id: scope.data.instance_id, limit: 8, include_conflicts: true });
});
test('group perspectives have separate source sessions and share one world even when connecting concurrently', async () => {
    const f = fixture();
    f.ctx.groupId = 'g'; f.ctx.chatId = 'group-chat-1';
    f.ctx.characters.push({ name: 'Shego', avatar: 'shego.png', data: { name: 'Shego' } });
    const one = f.bridge.scope(f.ctx, f.ctx.characters[0]);
    const two = f.bridge.scope(f.ctx, f.ctx.characters[1]);
    await Promise.all([f.bridge.connect(one), f.bridge.connect(two)]);
    const sessions = f.calls.filter(c => c.path === '/session').map(c => c.body.source_session_id);
    assert.deepEqual(sessions, ['group:g:chat:group-chat-1:view:Renamon', 'group:g:chat:group-chat-1:view:Shego']);
    assert.equal(one.data.world_id, two.data.world_id);
    assert.equal(selectedCard(f.ctx, { name: 'wrong', original_avatar: 'shego.png' }).name, 'Shego');
    await f.bridge.submit(one, 0, { mes: 'Hi', name: 'Shego', original_avatar: 'shego.png' });
    const body = f.calls.find(c => c.path === '/ingest').body;
    assert.equal(body.character_id, 'Renamon');
    assert.equal(body.speaker_id, 'Shego');
    assert.equal(body.viewpoint_id, 'Shego');
    assert.equal(body.recipient_id, null);
});
test('persisted card mapping survives display-name changes', () => {
    const f = fixture();
    f.ctx.characters[0].data.extensions = { [MODULE]: { character_id: 'Renamon' } };
    f.ctx.characters[0].name = 'Renamed Fox'; f.ctx.name2 = 'Renamed Fox';
    assert.equal(f.scope().data.character_id, 'Renamon');
});
test('reconnect reuses session metadata and re-resolves runtime state', async () => {
    const f = fixture(); await f.bridge.connect(f.scope());
    const old = f.scope().data.instance_id;
    f.bridge.reset();
    const scope = f.scope(); await f.bridge.connect(scope);
    assert.equal(scope.data.instance_id, old);
    assert.equal(f.calls.filter(c => c.path === '/session').length, 1);
    assert.equal(f.calls.filter(c => c.path.endsWith('/activate')).length, 2);
    assert.equal(f.calls.filter(c => c.path.endsWith('/state')).length, 2);
});
test('an API URL change isolates persisted sessions and world IDs', async () => {
    const f = fixture(); await f.bridge.connect(f.scope());
    const old = f.scope();
    f.settings.apiRoot = 'http://other-aios:8000';
    const next = f.scope();
    assert.notEqual(old.saved, next.saved);
    assert.equal(next.data.session_id, undefined);
    assert.equal(f.bridge.current(old), false);
});
test('old chat responses cannot mutate newly selected chat or save its metadata', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ handle: async path => path === '/session' ? await pending : undefined });
    const scope = f.scope();
    const connecting = f.bridge.connect(scope);
    await new Promise(resolve => setImmediate(resolve));
    const nextMetadata = {};
    f.change({ ...f.ctx, chatId: 'chat-b', chatMetadata: nextMetadata });
    release(response({ session_id: 'old-session' }));
    await assert.rejects(connecting, { name: 'AbortError' });
    assert.equal(scope.data.session_id, undefined);
    assert.deepEqual(nextMetadata, {});
});
test('deleted source slots block synchronization across reloads', async () => {
    const f = fixture();
    f.ctx.chat.push({ mes: 'Original', is_user: true });
    const scope = f.scope(); await f.bridge.reconcile(scope);
    f.ctx.chat.length = 0;
    await assert.rejects(f.bridge.reconcile(scope), /retraction/);
    f.bridge.reset();
    const reloaded = f.scope();
    assert.ok(reloaded.live.blocked);
    await assert.rejects(f.bridge.connect(reloaded), /retraction/);
});
test('reordered or replaced positional slots are detected without reinterpreting them as edits', async () => {
    const f = fixture();
    f.ctx.chat.push({ mes: 'First', is_user: true }, { mes: 'Second', is_user: false, name: 'Renamon' });
    const scope = f.scope(); await f.bridge.reconcile(scope);
    f.ctx.chat.reverse();
    await assert.rejects(f.bridge.reconcile(scope), /retraction/);
});
test('normal edits preserve source slot UUID and continue syncing', async () => {
    const f = fixture(); const scope = f.scope();
    const message = { mes: 'First', is_user: true };
    await f.bridge.submit(scope, 0, message);
    const id = message[MODULE].message_id;
    message.mes = 'Edited';
    await f.bridge.submit(scope, 0, message);
    assert.equal(message[MODULE].message_id, id);
    assert.equal(f.calls.filter(c => c.path === '/ingest').length, 2);
});
test('research timeout and pending responses preserve operation ID, completed operations get new IDs', async () => {
    let mode = 'fail';
    const f = fixture({ handle: (path, body) => {
        if (path.endsWith('/advance')) {
            if (mode === 'fail') throw new Error('lost connection');
            return response({ status: mode });
        }
    } });
    const scope = f.scope();
    await assert.rejects(f.bridge.researchStep(scope, 'dossier', 'advance', { include_fanwork: false }), /lost connection/);
    mode = 'pending'; await f.bridge.researchStep(scope, 'dossier', 'advance', { include_fanwork: false });
    mode = 'completed'; await f.bridge.researchStep(scope, 'dossier', 'advance', { include_fanwork: false });
    await f.bridge.researchStep(scope, 'dossier', 'advance', { include_fanwork: false });
    const ids = f.calls.filter(c => c.path.endsWith('/advance')).map(c => c.body.request_id);
    assert.equal(ids[0], ids[1]); assert.equal(ids[1], ids[2]); assert.notEqual(ids[2], ids[3]);
});
test('generic mutation timeout is not automatically retried', async () => {
    const f = fixture({ handle: path => { if (path.endsWith('/task')) throw new Error('timeout'); } });
    await assert.rejects(f.bridge.feature(f.scope(), 'task', { method: 'POST', body: { task_type: 'planning', objective: 'Cook' } }), /timeout/);
    assert.equal(f.calls.filter(c => c.path.endsWith('/task')).length, 1);
});
test('HUD responses are discarded if source head changed while preparing', async () => {
    let release;
    const f = fixture({ handle: async path => path.endsWith('/hud') ? new Promise(resolve => { release = resolve; }) : undefined });
    const scope = f.scope(); await f.bridge.connect(scope);
    scope.data.source_head_node_id = 'a';
    const prefetch = f.bridge.prefetch(scope);
    await new Promise(resolve => setImmediate(resolve));
    scope.data.source_head_node_id = 'b';
    release(response({ instance_id: scope.data.instance_id, generation_ready: true, text: 'old HUD' }));
    assert.equal(await prefetch, null);
    assert.equal(scope.live.cache, null);
});
test('HUD prefetch is single-flight for one source coordinate', async () => {
    const f = fixture(); const scope = f.scope(); await f.bridge.connect(scope);
    scope.data.source_head_node_id = 'a';
    const one = f.bridge.prefetch(scope); const two = f.bridge.prefetch(scope);
    assert.equal(one, two);
    assert.ok(await one);
    assert.equal(f.calls.filter(c => c.path.endsWith('/hud')).length, 1);
});
test('disabled extension rejects feature work and URL validation rejects credentials', () => {
    const f = fixture(); f.settings.enabled = false;
    assert.throws(() => f.scope(), /Enable/);
    assert.throws(() => normalizeRoot('http://user:secret@example.com'), /credentials/);
    assert.equal(normalizeRoot('localhost:8000/'), 'http://localhost:8000');
});

test('copied chat metadata cannot silently attach to the parent source session', async () => {
    const f = fixture(); await f.bridge.connect(f.scope());
    const metadata = clone(f.ctx.chatMetadata);
    f.change({ ...f.ctx, chatId: 'copied-chat', chatMetadata: metadata });
    assert.throws(() => f.scope(), /inherited another chat/);
});
test('human actor binding survives a display persona rename within a chat', () => {
    const f = fixture(); const old = f.scope();
    f.ctx.name1 = 'Mia Renamed';
    const renamed = f.scope();
    assert.equal(renamed.data.user_name, 'Mia');
    assert.equal(old.key, renamed.key);
});
test('group session keys differ for distinct chats in the same group', () => {
    const f = fixture(); f.ctx.groupId = 'g';
    const first = f.scope().sourceSession;
    f.change({ ...f.ctx, chatId: 'other-chat', chatMetadata: {} });
    assert.notEqual(f.scope().sourceSession, first);
});

test('HTTP LAN crypto fallbacks match SHA-256 vectors and generate valid UUIDs', async () => {
    const { sha256, uuid } = await import('../bridge.js');
    const { createHash, webcrypto } = await import('node:crypto');
    for (const text of ['', 'abc', 'Renamon 🦊', 'a'.repeat(55), 'b'.repeat(64), 'c'.repeat(1000)]) {
        assert.equal(sha256(new TextEncoder().encode(text)), createHash('sha256').update(text).digest('hex'));
    }
    assert.match(uuid({ getRandomValues: bytes => webcrypto.getRandomValues(bytes) }), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test('explicit state invalidation rejects in-flight HUD even at the same source coordinate', async () => {
    let release;
    const f = fixture({ handle: async path => path.endsWith('/hud') ? new Promise(resolve => { release = resolve; }) : undefined });
    const scope = f.scope(); await f.bridge.connect(scope); scope.data.source_head_node_id = 'a';
    const pending = f.bridge.prefetch(scope);
    await new Promise(resolve => setImmediate(resolve));
    f.bridge.invalidate(scope);
    release(response({ instance_id: scope.data.instance_id, generation_ready: true, text: 'before world action' }));
    assert.equal(await pending, null);
    assert.equal(scope.live.cache, null);
});

test('default browser fetch is called with the Window/global receiver', async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', function (url, options) {
        if (this !== globalThis) throw new TypeError("'fetch' called on an object that does not implement interface Window.");
        calls.push({ url, method: options.method });
        return Promise.resolve(response({ ok: true }));
    });
    const bridge = new AIOSBridge({ getContext: () => ({}), settings: () => ({ ...defaults }) });
    assert.deepEqual(await bridge.request('http://aios.test', '/healthz'), { ok: true });
    assert.deepEqual(calls, [{ url: 'http://aios.test/healthz', method: 'GET' }]);
});

test('23-message incremental reconciliation survives reconnect and only sends appended messages', async () => {
    const f = fixture();
    f.ctx.chat = Array.from({ length: 23 }, (_, i) => ({ mes: `Message ${i}`, is_user: true }));
    await f.bridge.reconcile(f.scope());
    await f.bridge.reconcile(f.scope());
    f.bridge.reset();
    await f.bridge.reconcile(f.scope());
    assert.equal(f.calls.filter(c => c.path === '/ingest').length, 23);
    f.ctx.chat.push({ mes: 'New', is_user: true });
    await f.bridge.reconcile(f.scope());
    assert.equal(f.calls.filter(c => c.path === '/ingest').length, 24);
});

test('edits, same-text swipe changes, and speaker changes invalidate receipts', async () => {
    const f = fixture();
    f.ctx.chat = [{ mes: 'One', is_user: true }, { mes: 'Two', name: 'Renamon', swipe_id: 0 }];
    await f.bridge.reconcile(f.scope());
    f.ctx.chat[0].mes = 'Edited';
    await f.bridge.reconcile(f.scope());
    f.ctx.chat[1].swipe_id = 1;
    await f.bridge.reconcile(f.scope());
    f.ctx.chat[1].is_user = true;
    await f.bridge.reconcile(f.scope());
    assert.deepEqual(f.calls.filter(c => c.path === '/ingest').map(c => [c.body.text, c.body.speaker_id, c.body.payload.swipe_id]),
        [['One', 'Mia', null], ['Two', 'Renamon', 0], ['Edited', 'Mia', null], ['Two', 'Renamon', 1], ['Two', 'Mia', 1]]);
});

test('missing or mismatched checkpoint conservatively replays every message', async () => {
    let reset = false;
    const f = fixture({ handle: path => reset && path.endsWith('/state') ? response({ source_head_node_id: null }) : undefined });
    f.ctx.chat = [{ mes: 'One', is_user: true }, { mes: 'Two', is_user: true }];
    await f.bridge.reconcile(f.scope());
    reset = true;
    f.bridge.reset();
    await f.bridge.reconcile(f.scope());
    assert.equal(f.calls.filter(c => c.path === '/ingest').length, 4);
    delete f.scope().data.sync_checkpoint;
    reset = false;
    f.bridge.reset();
    await f.bridge.reconcile(f.scope());
    assert.equal(f.calls.filter(c => c.path === '/ingest').length, 6);
});

test('overlapping reconciliation coalesces and includes edits during an active pass', async () => {
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const f = fixture({ handle: path => path === '/ingest' && !release ? new Promise(resolve => { release = resolve; entered(); }) : undefined });
    f.ctx.chat = [{ mes: 'Before', is_user: true }];
    const scope = f.scope();
    const first = f.bridge.reconcile(scope);
    await ready;
    f.ctx.chat[0].mes = 'After';
    f.ctx.chat.push({ mes: 'Added', is_user: true });
    const second = f.bridge.reconcile(scope);
    assert.equal(first, second);
    release(response({ node_id: 'initial', source_head_node_id: 'initial' }));
    await first;
    assert.deepEqual(f.calls.filter(c => c.path === '/ingest').map(c => c.body.text), ['Before', 'After', 'Added']);
});

test('changes received during the receipt save are not dropped', async () => {
    const f = fixture();
    f.ctx.chat = [{ mes: 'Before', is_user: true }];
    const scope = f.scope();
    await f.bridge.reconcile(scope);
    f.ctx.chat[0].mes = 'Trigger receipt save';
    let changed = false;
    f.ctx.saveMetadata = async () => {
        if (!changed) {
            changed = true;
            f.ctx.chat[0].mes = 'During save';
            void f.bridge.reconcile(scope);
        }
    };
    await f.bridge.reconcile(scope);
    assert.equal(f.calls.filter(c => c.path === '/ingest').at(-1).body.text, 'During save');
});

test('receipt saves are batched and failed passes preserve acknowledged progress', async () => {
    let fail = false;
    const f = fixture({ handle: (path, body) => fail && path === '/ingest' && body.text === 'Fail' ? response({}, 400) : undefined });
    const scope = f.scope();
    await f.bridge.connect(scope);
    let saves = 0;
    f.ctx.saveMetadata = async () => { saves++; };
    f.ctx.chat = Array.from({ length: 23 }, (_, i) => ({ mes: `Message ${i}`, is_user: true }));
    await f.bridge.reconcile(scope);
    assert.equal(saves, 2, 'one UUID save and one receipt checkpoint save');
    await f.bridge.reconcile(scope);
    assert.equal(saves, 2, 'unchanged reconciliation does not save the chat');
    fail = true;
    f.ctx.chat.push({ mes: 'Acknowledged', is_user: true }, { mes: 'Fail', is_user: true });
    await assert.rejects(f.bridge.reconcile(scope), /400/);
    assert.ok(scope.data.receipts[23].node_id);
    assert.equal(scope.data.receipts[24], undefined);
    fail = false;
    await f.bridge.reconcile(scope);
    assert.equal(f.calls.filter(c => c.path === '/ingest' && c.body.text === 'Acknowledged').length, 1);
});

test('generation refreshes same-head HUD task overlays without replaying ingestion', async () => {
    let hud = 'Before completion';
    const f = fixture({ handle: path => path.endsWith('/hud') ? response({ instance_id: 'instance-Renamon', generation_ready: true, text: hud }) : undefined });
    f.ctx.chat = [{ mes: 'Task', is_user: true }];
    const scope = f.scope();
    await f.bridge.reconcile(scope);
    await f.bridge.prefetch(scope);
    hud = 'Task completed';
    const result = await f.bridge.generationHud(scope, new AbortController().signal);
    assert.equal(result.text, 'Task completed');
    assert.equal(f.calls.filter(c => c.path === '/ingest').length, 1);
    assert.equal(f.calls.filter(c => c.path.endsWith('/hud')).length, 2);
});

test('generation discards HUD when the transcript changes during retrieval', async () => {
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const f = fixture({ handle: path => path.endsWith('/hud') ? new Promise(resolve => { release = resolve; entered(); }) : undefined });
    f.ctx.chat = [{ mes: 'Before', is_user: true }];
    const scope = f.scope();
    const result = f.bridge.generationHud(scope, new AbortController().signal);
    await ready;
    f.ctx.chat[0].mes = 'After';
    release(response({ instance_id: scope.data.instance_id, generation_ready: true, text: 'Stale' }));
    assert.equal(await result, null);
});

test('incremental skipping preserves live research dispatch after reconciliation', async () => {
    const f = fixture();
    f.ctx.chat = [{ mes: '<aios_action>{"op":"research","question":"Rice?"}</aios_action>', name: 'Renamon' }];
    const scope = f.scope();
    await f.bridge.reconcile(scope);
    await f.bridge.submit(scope, 0, f.ctx.chat[0], { dispatchResearch: true });
    await f.bridge.submit(scope, 0, f.ctx.chat[0], { dispatchResearch: true });
    assert.equal(f.calls.filter(c => c.path === '/ingest').length, 1);
    assert.equal(f.calls.filter(c => c.path.endsWith('/research/tool-request')).length, 1);
});


test('stale chat work is rejected even if SillyTavern reuses the metadata object', async () => {
    const f = fixture();
    const scope = f.scope();
    f.change({ ...f.ctx, chatId: 'different-chat' });
    assert.equal(f.bridge.current(scope), false);
    await assert.rejects(f.bridge.connect(scope), { name: 'AbortError' });
});
