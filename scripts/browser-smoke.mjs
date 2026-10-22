// Browser integration smoke test against mock SillyTavern modules and AIOS HTTP.
// Uses an installed Playwright, or the Work runtime's bundled copy.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let playwright;
if (!process.env.MVI_DOM) {
    try { playwright = await import('playwright'); }
    catch {
        if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('Install Playwright to run this optional browser smoke test');
        playwright = createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/package.json`)('playwright');
    }
}
const calls = [];
const D = '00000000-0000-4000-8000-000000000001';
const S = '00000000-0000-4000-8000-000000000002';
let node = 0;
let advanceFailed = false;
let origin;
const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    try {
        if (path.startsWith('/aios/')) {
            let raw = ''; for await (const chunk of req) raw += chunk;
            const body = raw ? JSON.parse(raw) : null;
            const api = path.slice('/aios'.length);
            calls.push({ api, body, method: req.method });
            if (api === '/healthz') return json({ ok: true });
            if (api === '/session') return json({ session_id: 'session-test' });
            if (api.endsWith('/identity/bootstrap/card')) return json({ identity_version: 1, accepted_count: body.auto_accept_authored ? 3 : 0 });
            if (api.endsWith('/identity')) return json({ identity: { character_id: 'Renamon' }, candidates: [{ candidate_id: D }] });
            if (api.endsWith('/activate')) return json({ instance_id: `instance-${api.split('/')[2]}`, character_id: api.split('/')[2], world_id: 'world-test', entity_id: 'entity-test', state_version: 1, timeline_id: 'timeline-test' });
            if (api.endsWith('/state')) return json({ instance_id: api.split('/')[2], state_version: 1, source_head_node_id: node ? `node-${node}` : null });
            if (api === '/ingest') return json({ node_id: `node-${++node}`, source_head_node_id: `node-${node}`, source_current: true, disposition: 'new', timeline_id: 'source-timeline' });
            if (api.endsWith('/hud')) return json({ instance_id: api.split('/')[2], generation_ready: true, text: 'Character remembers rice.', freshness: { ready: true }, frame: { goals: ['Learn cooking'] } });
            if (api === '/epistemic/search') return json({ results: [{ canonical_text: 'Rice is food', conflicts: [] }], instance_id: body.instance_id });
            if (api.endsWith('/research') && req.method === 'GET') return json({ dossiers: [{ dossier_id: D, status: 'open', question: 'How to cook?' }] });
            if (api.endsWith('/research') && req.method === 'POST') return json({ dossier_id: D, status: 'open' });
            if (api.endsWith(`/research/${D}`)) return json({ dossier: { dossier_id: D }, sources: [{ section_id: S, title: '<img src=x onerror=alert(1)>', excerpt: 'Use a pot', status: 'discovered' }] });
            if (api.endsWith('/advance')) {
                if (!advanceFailed) { advanceFailed = true; res.statusCode = 503; return json({ error: 'temporary test failure' }); }
                return json({ status: 'completed', durable_knowledge: false });
            }
            if (api.endsWith('/study')) return json({ status: 'submitted_to_ingestion' });
            if (api === '/corpus/document') return json({ document_id: D, section_count: 1, deduplicated: false });
            if (api.endsWith('/task')) return json({ task_id: D, status: 'queued' });
            if (api.endsWith('/action')) return json({ ok: true, state_version: 2 });
            return json({ ok: true });
        }
        if (path === '/script.js') {
            res.setHeader('Content-Type', 'text/javascript');
            return res.end(`export const eventSource=window.events; export const event_types=window.types;
                export const extension_prompt_types={IN_PROMPT:1};
                export const setExtensionPrompt=(...args)=>window.prompts.push(args);
                export const saveSettingsDebounced=()=>{};`);
        }
        if (path === '/scripts/extensions.js') {
            res.setHeader('Content-Type', 'text/javascript');
            return res.end(`export const getContext=()=>window.ctx;
                export const extension_settings={MemoryVaultIngest:{apiRoot:${JSON.stringify(origin + '/aios')},logHudText:false}};
                export const renderExtensionTemplateAsync=async()=>await (await fetch('/settings.html')).text();`);
        }
        if (path === '/settings.html') { res.setHeader('Content-Type', 'text/html'); return res.end(await readFile(root + 'settings.html')); }
        if (path.endsWith('/index.js') || path.endsWith('/bridge.js')) {
            res.setHeader('Content-Type', 'text/javascript');
            return res.end(await readFile(root + path.split('/').at(-1)));
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
            body{background:#202126;color:#eee;font:16px system-ui;max-width:850px;margin:24px auto}input,textarea,select,button{font:inherit;background:#34353a;color:#eee;border:1px solid #777;padding:5px;max-width:100%;box-sizing:border-box}label,small{display:block;margin:6px 0}button{margin:4px}details{padding:12px;border:1px solid #555;margin:8px 0}textarea,.text_pole{width:100%}pre{font-size:13px}
            </style></head><body><div id="extensions_settings2"></div><script>
            window.prompts=[];window.tool=null;
            const handlers=new Map();window.events={on:(name,fn)=>{const list=handlers.get(name)||[];list.push(fn);handlers.set(name,list)},emit:async(name,...args)=>{for(const fn of handlers.get(name)||[])await fn(...args)}};
            window.types=Object.fromEntries(['MESSAGE_SENT','CHARACTER_MESSAGE_RENDERED','MESSAGE_UPDATED','MESSAGE_SWIPED','CHAT_CHANGED','CHAT_RENAMED','GROUP_MEMBER_DRAFTED','CHARACTER_EDITED','PERSONA_CHANGED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED','CHAT_DELETED','WORLD_INFO_ACTIVATED','GENERATION_STOPPED','GENERATION_ENDED'].map(n=>[n,n]));
            window.ctx={name1:'Mia',name2:'Renamon',characterId:0,groupId:null,chatId:'smoke-chat',chatMetadata:{},characters:[{name:'Renamon',avatar:'renamon.png',data:{name:'Renamon',description:'Fox',personality:'Calm'}}],chat:[{mes:'Learn to cook',is_user:true,name:'Mia'},{mes:'I will learn',is_user:false,name:'Renamon'}],saveMetadata:async()=>{},saveChat:async()=>{},writeExtensionField:async(i,key,value)=>{window.ctx.characters[i].data.extensions||={};window.ctx.characters[i].data.extensions[key]=value},registerFunctionTool:t=>window.tool=t,unregisterFunctionTool:()=>window.tool=null,isToolCallingSupported:()=>true};
            window.$=selector=>({append:html=>document.querySelector(selector).insertAdjacentHTML('beforeend',html)});window.jQuery=fn=>fn();
            </script><script type="module" src="/scripts/extensions/third-party/MemoryVaultIngest/index.js"></script></body></html>`);
    } catch (error) { res.statusCode = 500; res.end(error.stack); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
    if (process.env.MVI_DOM) {
        const { JSDOM } = await import(process.env.MVI_JSDOM_PATH || 'jsdom');
        let dom;
        const wait = async fn => {
            const deadline = Date.now() + 5000;
            while (!await fn()) {
                if (Date.now() > deadline) throw new Error('DOM smoke wait timed out');
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        };
        const page = {
            on: () => {},
            async goto(url) {
                dom = new JSDOM(await (await fetch(url)).text(), { url, runScripts: 'dangerously' });
                globalThis.window = dom.window; globalThis.document = dom.window.document;
                globalThis.$ = dom.window.$; globalThis.jQuery = dom.window.jQuery;
                window.mockScript = { eventSource: window.events, event_types: window.types, extension_prompt_types: { IN_PROMPT: 1 },
                    setExtensionPrompt: (...args) => window.prompts.push(args), saveSettingsDebounced: () => {} };
                window.mockExtensions = { getContext: () => window.ctx, extension_settings: { MemoryVaultIngest: { apiRoot: origin + '/aios', logHudText: false } },
                    renderExtensionTemplateAsync: async () => await (await fetch(origin + '/settings.html')).text() };
                let code = await readFile(root + 'index.js', 'utf8');
                code = code.replace(/import \{([^}]+)\} from '\.\.\/\.\.\/\.\.\/\.\.\/script\.js';/, 'const {$1} = window.mockScript;');
                code = code.replace(/import \{([^}]+)\} from '\.\.\/\.\.\/\.\.\/extensions\.js';/, 'const {$1} = window.mockExtensions;');
                code = code.replace("from './bridge.js'", `from '${new URL('../bridge.js', import.meta.url).href}'`);
                code += '\n//# sourceURL=memoryvaultingest-dom-test.js';
                await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
            },
            waitForFunction: wait,
            evaluate: fn => fn(),
            locator(selector) {
                const nodes = () => [...document.querySelectorAll(selector)];
                const first = () => { const value = nodes()[0]; if (!value) throw new Error('Missing control ' + selector); return value; };
                return {
                    evaluateAll: fn => fn(nodes()), textContent: async () => first().textContent,
                    count: async () => nodes().length,
                    fill: async value => { first().value = value; },
                    click: async () => { first().click(); },
                    check: async () => { const node = first(); if (!node.checked) node.click(); },
                    selectOption: async value => { first().value = value; first().dispatchEvent(new window.Event('change')); },
                };
            },
        };
        browser = { newPage: async () => page, close: async () => { window.dispatchEvent(new window.Event('beforeunload')); dom.window.close(); } };
    } else browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => document.getElementById('mvi_runtime_status')?.textContent.startsWith('READY'));
    assert.equal(await page.locator('[id]').evaluateAll(nodes => nodes.length === new Set(nodes.map(n => n.id)).size), true, 'unique control IDs');
    await page.locator('details').evaluateAll(nodes => nodes.forEach(n => n.open = true));
    const click = async id => { await page.locator('#' + id).click(); await page.waitForFunction(() => !document.getElementById('mvi_refresh').disabled); };
    await page.locator('#mvi_query').fill('rice'); await click('mvi_recall');
    assert.match(await page.locator('#mvi_result').textContent(), /Rice is food/);
    assert.equal(calls.find(c => c.api === '/epistemic/search').body.instance_id, 'instance-Renamon');
    await page.locator('#mvi_question').fill('How to cook rice?'); await click('mvi_research_open'); await click('mvi_research_inspect');
    assert.equal(await page.locator('#mvi_sources img').count(), 0, 'source titles must be rendered as text');
    await click('mvi_research_advance'); await click('mvi_research_advance');
    const advances = calls.filter(c => c.api.endsWith('/advance'));
    assert.equal(advances.length, 2); assert.equal(advances[0].body.request_id, advances[1].body.request_id);
    await page.locator('#mvi_sources input').check(); await click('mvi_research_study');
    assert.match(await page.locator('#mvi_result').textContent(), /submitted_to_ingestion/);
    await page.locator('#mvi_resource_title').fill('Cooking notes'); await page.locator('#mvi_resource_text').fill('Rinse rice.'); await click('mvi_resource_import');
    assert.equal(calls.filter(c => c.api === '/corpus/document').length, 1);
    assert.equal(calls.some(c => c.api === '/document/ingest'), false);
    await page.evaluate(() => window.events.emit('WORLD_INFO_ACTIVATED', [{ world: 'kitchen', uid: 1, content: 'A pot is available.', comment: 'Kitchen' }]));
    await click('mvi_lore_import');
    assert.equal(calls.filter(c => c.api === '/corpus/document').length, 2);
    await click('mvi_stage_identity');
    const imports = calls.filter(c => c.api.endsWith('/identity/bootstrap/card'));
    assert.equal(imports.at(-1).body.auto_accept_authored, false);
    await click('mvi_identity');
    assert.equal(calls.filter(c => c.api.endsWith('/identity/bootstrap/card')).length, imports.length, 'inspection must not accept staged card');
    await page.locator('#mvi_native_recall').check();
    const recall = await page.evaluate(async () => JSON.parse(await window.tool.action({ query: 'rice' })));
    assert.equal(recall.instance_id, 'instance-Renamon');
    await page.locator('#mvi_objective').fill('Plan a cooking lesson'); await click('mvi_task'); await click('mvi_wake');
    assert.equal(calls.filter(c => c.api.endsWith('/task')).length, 1);
    assert.ok(calls.some(c => c.api === '/agent/integrations/memoryvaultingest/event'));
    await page.locator('#mvi_action_type').selectOption('move'); await page.locator('#mvi_action_target').fill(D); await click('mvi_action');
    assert.equal(calls.find(c => c.api.endsWith('/action')).body.expected_state_version, 1);
    await page.evaluate(() => window.MemoryVaultIngest_Intercept([], 4096, () => {}, 'normal'));
    assert.match(await page.evaluate(() => window.prompts.at(-1)[1]), /Character remembers rice/);
    await page.evaluate(() => window.events.emit('MESSAGE_DELETED', 1));
    await page.evaluate(() => window.MemoryVaultIngest_Intercept([], 4096, () => {}, 'normal'));
    assert.equal(await page.evaluate(() => window.prompts.at(-1)[1]), '');
    assert.equal(errors.length, 0, errors.join('\n'));
    if (!process.env.MVI_DOM && process.env.MVI_SCREENSHOT) await page.screenshot({ path: process.env.MVI_SCREENSHOT, fullPage: true });
    console.log(`${process.env.MVI_DOM ? 'DOM' : 'Browser'} smoke passed: initialization, recall, research retry/study, resources/lore, staged identity, native tool, task/event, runtime action, HUD injection, deletion block.`);
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
