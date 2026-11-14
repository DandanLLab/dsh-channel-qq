/** QQ 设置 API: settings-page backend for the bundled QQ settings section.
 *
 * GET  /channel-qq-api          → live hot settings (subset)
 * POST /channel-qq-api {patch}  → mutate the live config object in place
 *                                 (hot-apply: talkValue/requireMention/persona/
 *                                  dmGate/emoji take effect on the next event)
 *                                 and persist to <dshHome>/channel-qq/settings.json
 *                                 (re-applied over defaults on every boot).
 *
 * Security: loopback-only via Host-header check (DNS-rebinding safe, same as
 * the meme component), no secrets returned.
 */
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describeClient, capabilityMatrixOf } from './client-compat.js';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function denyNonLoopback(req, res) {
    const raw = String(req.headers.host ?? '');
    const name = raw.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
    if (LOOPBACK_HOSTS.has(name.toLowerCase()))
        return false;
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('loopback only');
    return true;
}
/** Whitelisted hot fields and their types (everything else is ignored).
 * Kinds: number / boolean / string 标量；'number?' 可空数字（空值→null）；
 * 'number[]' / 'string[]' 数组（接受 JSON 数组或逗号分隔字符串）。
 * accessToken 可写但 GET 一律不回传（loopback-only 也不外泄密钥）。 */
const HOT_SCALARS = {
    // 连接（保存后自动触发一次重连）
    'connection.url': 'string',
    'connection.accessToken': 'string',
    'connection.mode': 'string',
    'selfId': 'number',
    // 聊天触发
    'talkValue': 'number',
    'requireMention': 'boolean',
    'groupEnabled': 'boolean',
    'rateLimitMs': 'number',
    'maxMessageLength': 'number',
    // 群/私聊路由
    'primaryGroup': 'number?',
    'extraGroups': 'number[]',
    'admins': 'number[]',
    'groupModel.provider': 'string?',
    'groupModel.model': 'string?',
    // persona
    'persona.selfName': 'string',
    'persona.masterName': 'string',
    'persona.peerName': 'string',
    'persona.pronoun': 'string',
    // 分段与批处理
    'segmentation.enabled': 'boolean',
    'segmentation.maxSegments': 'number',
    'batching.windowMs': 'number',
    'batching.maxMessages': 'number',
    // 戳一戳 / 图片识别
    'poke.enabled': 'boolean',
    'poke.pokeBack': 'boolean',
    'imageRecognition.enabled': 'boolean',
    // 表情
    'emoji.steal': 'boolean',
    'emoji.autoSend': 'boolean',
    'emoji.autoSendProbability': 'number',
    // 陌生人门控
    'dmGate.enabled': 'boolean',
    'dmGate.notifyAdmin': 'boolean',
    'dmGate.groupAlert': 'boolean',
    'dmGate.pendingReply': 'string',
    'dmGate.allowList': 'number[]',
    // 会话（对新建窗口生效；存量会话保持原样）
    'workspacePath': 'string',
    'agentPreset': 'string',
};
function toNumberArray(v) {
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/).filter(Boolean) : null;
    if (raw === null)
        return null;
    return raw.map((x) => Number(x)).filter((n) => Number.isFinite(n));
}
function toStringArray(v) {
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，]+/).map((s) => s.trim()).filter(Boolean) : null;
    if (raw === null)
        return null;
    return raw.map((x) => String(x).slice(0, 80));
}
/** Coerce one whitelisted field; undefined = invalid, caller skips it. */
function coerceHot(kind, v) {
    if (kind === 'number') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    if (kind === 'number?') {
        if (v === '' || v === null || v === undefined)
            return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    if (kind === 'string?') {
        if (v === '' || v === null || v === undefined)
            return null;
        return String(v).slice(0, 120);
    }
    if (kind === 'boolean')
        return v === true || v === 'true';
    if (kind === 'number[]') {
        const a = toNumberArray(v);
        return a === null ? undefined : a;
    }
    if (kind === 'string[]') {
        const a = toStringArray(v);
        return a === null ? undefined : a;
    }
    return String(v ?? '').slice(0, 300);
}
function getPath(obj, dotPath) {
    let cur = obj;
    for (const seg of dotPath.split('.')) {
        if (cur === null || cur === undefined)
            return undefined;
        cur = cur[seg];
    }
    return cur;
}
function setPath(obj, dotPath, value) {
    const segs = dotPath.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        if (typeof cur[segs[i]] !== 'object' || cur[segs[i]] === null)
            cur[segs[i]] = {};
        cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
}
export function registerSettingsApi(ctx, config, dshHome, log, client, getBridge) {
    const overlayFile = path.join(dshHome, 'channel-qq', 'settings.json');
    /** Apply a patch object to the live config (whitelisted fields only). Returns applied keys. */
    function applyPatch(patch) {
        const applied = [];
        for (const [k, v] of Object.entries(patch)) {
            const kind = HOT_SCALARS[k];
            if (kind === undefined)
                continue;
            // accessToken：留空 = 不修改（避免误清空）
            if (k === 'connection.accessToken' && String(v ?? '').trim() === '')
                continue;
            const coerced = coerceHot(kind, v);
            if (coerced === undefined)
                continue;
            setPath(config, k, coerced);
            applied.push(k);
        }
        return applied;
    }
    /** Persist the overlay (re-applied over defaults on every boot).
     *  必须与现有文件合并：否则每次保存都会把之前保存过的字段从持久层抹掉（重启即丢）。 */
    async function persistOverlay(applied) {
        let overlay = {};
        try {
            overlay = JSON.parse(await fs.readFile(overlayFile, 'utf8'));
        }
        catch { /* 还没有 overlay */ }
        for (const k of applied) {
            const v = getPath(config, k);
            if (v !== undefined)
                overlay[k] = v;
        }
        await fs.mkdir(path.dirname(overlayFile), { recursive: true });
        await fs.writeFile(overlayFile, JSON.stringify(overlay, null, 1));
    }
    /** 默认路由（defaultModel.provider/model[/reasoningEffort]）写入 DSH profile 的 agentDefaultModel —— 不进 settings.json。
     *  saveSelection 走 configEditor 落盘到 profile，重启后仍生效；存量会话由 bridge 的
     *  syncResumedModel 在下次恢复时跟随新默认。 */
    async function applyDefaultModelPatch(patch, applied) {
        const provider = typeof patch['defaultModel.provider'] === 'string' ? patch['defaultModel.provider'].trim() : '';
        const model = typeof patch['defaultModel.model'] === 'string' ? patch['defaultModel.model'].trim() : '';
        if (provider === '' || model === '')
            return;
        // 推理力度：空 = 跟随 adapter 默认
        const rawEffort = typeof patch['defaultModel.reasoningEffort'] === 'string' ? patch['defaultModel.reasoningEffort'].trim() : '';
        const effort = ['off', 'low', 'medium', 'high'].includes(rawEffort) ? rawEffort : undefined;
        const adm = ctx.agentDefaultModel;
        if (adm?.saveSelection === undefined) {
            log('settings-api: agentDefaultModel.saveSelection unavailable — default model not changed');
            return;
        }
        await adm.saveSelection({ provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) });
        const now = adm.currentSelection?.();
        log(`settings-api: default model → ${now?.provider ?? provider}/${now?.model ?? model}${now?.reasoningEffort ? ` (effort ${now.reasoningEffort})` : ''}`);
        applied.push('defaultModel.provider', 'defaultModel.model');
        // 立即热切换：所有活会话重指向新默认路由（下一 turn 生效）
        try {
            getBridge?.()?.hotReselectModel();
        }
        catch { /* bridge 未就绪时跳过，恢复时仍会同步 */ }
    }
    /** Apply one incoming patch: channel hot fields → config+overlay, 默认路由 → DSH profile. */
    async function processPatch(patch) {
        const applied = applyPatch(patch);
        // persona 热同步：setEmotionPersona 只在启动时调用过一次，改了称呼必须立即跟随
        if (applied.some((k) => k.startsWith('persona.'))) {
            try {
                const { setEmotionPersona } = await import('./emotion.js');
                setEmotionPersona(config.persona.masterName, config.persona.pronoun);
            }
            catch { /* emotion 模块未挂载时跳过 */ }
        }
        await applyDefaultModelPatch(patch, applied);
        await persistOverlay(applied);
        reconnectIfConnectionChanged(applied);
        log(`settings-api: saved ${applied.length} fields`);
        return applied;
    }
    /** Connection-level edits need a redial to take effect. */
    function reconnectIfConnectionChanged(applied) {
        if (applied.some((k) => k.startsWith('connection.')) && typeof client?.forceReconnect === 'function') {
            setTimeout(() => { try {
                client.forceReconnect?.();
            }
            catch { /* socket state raced */ } }, 120);
        }
    }
    /** Boot-time: re-apply the persisted overlay over the resolved config.
     *  必须同步完成：connection.mode/url 等字段决定客户端启动形态，异步应用会与
     *  client.start() 竞态（overlay 里 mode=reverse 时开机仍走 forward、反向服务器不监听）。 */
    function applyOverlaySync() {
        try {
            const raw = JSON.parse(readFileSync(overlayFile, 'utf8'));
            let applied = 0;
            for (const [k, v] of Object.entries(raw)) {
                if (!(k in HOT_SCALARS))
                    continue;
                setPath(config, k, v);
                applied++;
            }
            if (applied > 0)
                log(`settings-api: overlay applied (${applied} fields from settings.json)`);
        }
        catch { /* no overlay yet */ }
    }
    applyOverlaySync();
    let webServer;
    try {
        webServer = ctx.webServer;
    }
    catch {
        webServer = undefined;
    }
    if (webServer === undefined) {
        log('settings-api: webServer unavailable — settings page read-only off');
        return () => { };
    }
    const json = (res, code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
    };
    const offGetTest = webServer.register({
        kind: 'exact',
        path: '/channel-qq-api/test',
        handler: (req, res) => {
            if (denyNonLoopback(req, res))
                return;
            if (req.method === 'GET') {
                const id = client?.clientIdentity ?? null;
                json(res, 200, { ok: true, connected: client?.isConnected?.() ?? null, client: id, describe: id ? describeClient(id) : '尚未探测到（连接刚建立或探测失败）', capabilities: id ? capabilityMatrixOf(id.kind) : {} });
                return;
            }
            if (req.method === 'POST') {
                let bodyRaw = '';
                req.on('data', (c) => { if (bodyRaw.length < 100_000)
                    bodyRaw += c; });
                req.on('end', async () => {
                    try {
                        const patch = JSON.parse(bodyRaw);
                        const applied = await processPatch(patch);
                        json(res, 200, { ok: true, applied });
                    }
                    catch (e) {
                        json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                });
                return;
            }
            json(res, 405, { ok: false, error: 'method' });
        },
    });
    const offGet = webServer.register({
        kind: 'exact',
        path: '/channel-qq-api',
        handler: (req, res) => {
            if (denyNonLoopback(req, res))
                return;
            if (req.method === 'GET') {
                const out = {};
                for (const k of Object.keys(HOT_SCALARS)) {
                    // 密钥一律不回传（面板显示「已配置」，留空=不修改）
                    if (k.endsWith('accessToken'))
                        continue;
                    out[k] = getPath(config, k);
                }
                json(res, 200, {
                    ok: true,
                    settings: out,
                    client: client?.clientIdentity ?? null,
                    connection: { mode: client?.connection.mode ?? config.connection.mode, url: client?.connection.url ?? config.connection.url },
                });
                return;
            }
            if (req.method === 'POST') {
                let bodyRaw = '';
                req.on('data', (c) => { if (bodyRaw.length < 100_000)
                    bodyRaw += c; });
                req.on('end', async () => {
                    try {
                        const patch = JSON.parse(bodyRaw);
                        const applied = await processPatch(patch);
                        json(res, 200, { ok: true, applied });
                    }
                    catch (e) {
                        json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                });
                return;
            }
            json(res, 405, { ok: false, error: 'method' });
        },
    });
    /** 模型目录 + 当前默认路由：面板下拉用（DSH 已注册 provider 及其广告模型）。 */
    const offModels = webServer.register({
        kind: 'exact',
        path: '/channel-qq-api/models',
        handler: (req, res) => {
            if (denyNonLoopback(req, res))
                return;
            if (req.method !== 'GET')
                return json(res, 405, { ok: false, error: 'method' });
            void (async () => {
                const rec = ctx;
                const defaultModel = rec.agentDefaultModel?.currentSelection?.() ?? null;
                const llm = rec.llm;
                const catalog = [];
                for (const p of llm?.listConfigurableProviders?.() ?? []) {
                    let models = [];
                    try {
                        models = ((await llm?.listModels?.(p.provider)) ?? []).map((m) => ({ id: m.id, name: m.name }));
                    }
                    catch { /* 未配置/休眠的 provider：保留空组让前端跳过 */ }
                    catalog.push({ provider: p.provider, displayName: p.displayName, models });
                }
                json(res, 200, { ok: true, models: catalog, defaultModel });
            })();
        },
    });
    log('settings-api: /channel-qq-api registered (loopback only)');
    return () => { offGetTest(); offGet(); offModels(); };
}
