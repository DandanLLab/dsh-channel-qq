/** dsh-channel-qq — QQ channel plugin for DeepSeek Harness over OneBot v11.
 *
 * Ported from an earlier OneBot `qq` channel. What moved over:
 *   - OneBot v11 transport (forward/reverse WS, echo API calls, reconnect)
 *   - trigger gate (mention / keyword / talk-value probability)
 *   - keyword reaction hints, smart segmentation, rate limiting, length caps
 *   - a OneBot tool subset for the agent
 *   - lite sticker stealing / auto-send
 * What deliberately did not move: the plugin's own access-control and
 * moderation stack (the harness's permission presets own that), its custom
 * model-caller rotation (the harness's llm seam owns that), and its
 * heartflow/PFC brain (the harness agent loop owns that). Persona comes from
 * the agent preset + workspace instruction files, not from channel config.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { Service } from '@deepseek-ai/cordis';
import { resolveConfig } from './config.js';
import { OneBotClient } from './onebot.js';
import { OutboundQueue } from './outbound.js';
import { parseInbound } from './segments.js';
import { ConversationBridge } from './bridge.js';
import { registerQQTools } from './tools.js';
import { applyLifeEngine } from './life/index.js';
import { DmGate } from './dm-gate.js';
import { applyMemeEngine } from './meme/index.js';
import { registerSettingsApi } from './settings-api.js';
import { EmojiStore } from './emoji.js';
import { Scheduler } from './scheduler.js';
import { SentLog } from './sent-log.js';
import { AffectionStore } from './affection.js';
import { setEmotionPersona, SixDimEngine } from './emotion.js';
import { KnowledgeStore } from './knowledge.js';
import { EmojiLibrary } from './emoji-library.js';
function defaultDshHome() {
    return process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
}
export class ChannelQQ extends Service {
    static inject = [
        'llm',
        'agents',
        'agentPresets',
        'agentDefaultModel',
        'permissionPresets',
        'sessionTitle',
        'workspaceRegistry',
        'tools',
        'attachments',
        // life-engine / meme-engine 组件依赖（systemPrompt 注入段、工蜂桥、图库面板路由）
        'systemPrompt',
        'subagents',
        'webServer',
    ];
    config;
    client = null;
    bridge = null;
    emoji = null;
    scheduler = null;
    dmGate = null;
    emojiLibrary = null;
    log;
    constructor(ctx, config) {
        super(ctx, 'channelQQ');
        this.config = resolveConfig(config);
        // The harness console logger only surfaces warnings by default; mirror
        // channel activity to a file so connection and reply-capture issues stay
        // debuggable (and the stream-frame shape calibratable) in the field.
        const logFile = path.join(defaultDshHome(), 'channel-qq.log');
        this.log = (line) => {
            ctx.logger.info(`channel-qq: ${line}`);
            void fs.appendFile(logFile, `${new Date().toISOString()} ${line}\n`).catch(() => { });
        };
    }
    async *[Service.init]() {
        const config = this.config;
        this.log(`starting (mode=${config.connection.mode}, url=${config.connection.url}, selfId=${config.selfId})`);
        this.client = new OneBotClient(config.connection, config.accessToken, this.log);
        const out = new OutboundQueue(this.client, config, this.log);
        this.bridge = new ConversationBridge(this.ctx, config, this.client, out, this.log);
        this.emojiLibrary = new EmojiLibrary(config.emoji, this.log);
        await this.emojiLibrary.load();
        this.emoji = new EmojiStore(config.emoji, this.client, this.log, this.emojiLibrary);
        setEmotionPersona(config.persona.masterName, config.persona.pronoun);
        await this.emoji.init();
        // Auto-emoji is model-judged now: the persona tells her to list, judge the
        // room, and only send when a sticker genuinely fits. No blind dice roll.
        this.client.on('connect', () => {
            this.log('QQ link ready');
        });
        this.client.on('event', (event) => {
            void this.onEvent(event);
        });
        const primarySentLog = new SentLog(defaultDshHome(), config.primaryGroup !== null ? `group-${config.primaryGroup}` : 'group-none', this.log);
        await primarySentLog.load();
        const affection = new AffectionStore(defaultDshHome(), this.log);
        await affection.load();
        affection.configure({ selfName: config.persona.selfName, masterName: config.persona.masterName });
        affection.serve(config.affectionPort, {
            workspacePath: config.workspacePath,
            onSubmit: (prompt) => {
                if (this.bridge === null)
                    return;
                void this.bridge.adminPrompt(prompt).catch((e) => this.log(`admin prompt failed: ${e.message}`));
            },
        });
        const knowledgeStore = new KnowledgeStore(defaultDshHome(), config.workspacePath, this.log);
        await knowledgeStore.load();
        this.bridge.knowledge = knowledgeStore;
        // 六维情感账本（亲密/信任/心动/安全/默契/张力）：入站命中分摊、出站行为暗示
        const sixDim = new SixDimEngine(defaultDshHome(), this.log);
        await sixDim.load();
        this.bridge.sixDimEngine = sixDim;
        // 陌生人私聊门控：非 admins 私聊先过审（好友自动放行 / 陌生人待审 + 通知主人审计）
        const dmGate = new DmGate(defaultDshHome(), config.dmGate, config.admins, () => this.client, this.log);
        await dmGate.load();
        this.dmGate = dmGate;
        this.bridge.dmGate = dmGate;
        const disposeTools = registerQQTools(this.ctx, config, this.client, out, this.log, this.emojiLibrary ?? undefined, affection, primarySentLog, knowledgeStore, sixDim, dmGate);
        // Life Engine 组件（dsh-life-engine 并入）：记忆可塑性/内心独白/睡眠巩固/KB 检索，config.lifeEngine.enabled 开关
        const disposeLife = await applyLifeEngine(this.ctx, config, this.log);
        // Meme Engine 组件（dsh-meme 并入）：图库/send_meme/learn_meme/管理面板，config.memeEngine.enabled 开关
        const disposeMeme = await applyMemeEngine(this.ctx, config, this.client, out, this.log);
        // 设置页后端（QQ 设置 section 的读写 API）：回环 only + 热改 config + settings.json 持久化
        const disposeSettings = registerSettingsApi(this.ctx, config, defaultDshHome(), this.log, this.client);
        yield async () => {
            disposeSettings();
            disposeMeme();
            disposeLife();
            disposeTools();
            this.scheduler?.dispose();
            this.scheduler = null;
            this.bridge?.dispose();
            this.client?.stop();
            this.client = null;
            this.bridge = null;
            this.emoji = null;
            void this.emojiLibrary?.save();
            this.emojiLibrary = null;
        };
        this.client.start();
        // 主窗直发桥（owner 令"直接连上 QQ 客户端发"）：绕过回合队列直达 OneBot。
        // 仅绑 127.0.0.1；key 从环境变量读取（部署者自选任意密钥注入）；只允许私聊 admins / 群聊 primaryGroup+extraGroups。
        const bridgeKey = process.env.CHANNEL_QQ_BRIDGE_KEY ?? '';
        const bridge = http.createServer((req, res) => {
            const reply = (code, body) => {
                res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(body));
            };
            if (req.method !== 'POST')
                return reply(405, { ok: false, error: 'method' });
            let raw = '';
            req.on('data', (c) => { if (raw.length < 1_000_000)
                raw += c; });
            req.on('end', async () => {
                try {
                    const body = JSON.parse(raw);
                    if (!bridgeKey || body.key !== bridgeKey)
                        return reply(401, { ok: false, error: 'bad key' });
                    const target = Number(body.target);
                    const admins = this.config.admins ?? [];
                    const groupsAllowed = [this.config.primaryGroup, ...(this.config.extraGroups ?? [])].filter((v) => v !== null);
                    const isPrivate = !groupsAllowed.includes(target);
                    if (isPrivate && !admins.includes(target))
                        return reply(403, { ok: false, error: `target ${target} 不在白名单（admins/primaryGroup/extraGroups）` });
                    const segments = [];
                    if (body.filePath) {
                        const abs = path.resolve(body.filePath);
                        await fs.access(abs);
                        segments.push({ type: 'file', data: { file: `file:///${abs.replace(/\\/g, '/')}` } });
                    }
                    if (body.text)
                        segments.push({ type: 'text', data: { text: body.text.slice(0, 4000) } });
                    if (segments.length === 0)
                        return reply(400, { ok: false, error: 'text/filePath 至少给一个' });
                    // 立即应答，发送结果异步落账（NapCat 文件上传回执可能 >100s，不能让调用方干等）
                    reply(200, { ok: true, queued: true, segments: segments.length });
                    const label = `${body.filePath ? 'file ' + path.basename(body.filePath) + ' ' : ''}${body.text ? 'text ' : ''}-> ${isPrivate ? 'dm' : 'group'}-${target}`;
                    const call = isPrivate
                        ? this.client?.call('send_private_msg', { user_id: target, message: segments })
                        : this.client?.call('send_group_msg', { group_id: target, message: segments });
                    void call
                        ?.then(() => this.log(`admin-bridge: sent ${label}`))
                        .catch((e) => this.log(`admin-bridge: FAILED ${label}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`));
                }
                catch (e) {
                    return reply(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
                }
            });
        });
        bridge.listen(8095, '127.0.0.1');
        this.log('admin-bridge listening on 127.0.0.1:8095');
        void this.bridge.reattachPersistedSessions();
        this.scheduler = new Scheduler(this.bridge, config, this.log, {
            workspace: config.workspacePath ?? undefined,
            onExtract: async (source, text) => {
                // 2026-09-26 主人令：不调用任何 API——知识提取由主模型自己判断完成
                //（注入任务到主会话，她用 extract_knowledge 工具自查自判入库）
                const clipped = text.slice(0, 4000);
                try {
                    await this.bridge?.dmProactive(`【知识提取任务】读今天的日记（${source}），自己判断哪些是值得长期记住的知识，用 extract_knowledge 工具入库。不要调用任何外部 API，全部由你自己判断。\n日记节选：\n${clipped}`);
                    this.log(`knowledge: task injected to main session for ${source}`);
                }
                catch (e) {
                    this.log(`knowledge inject failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                return 0;
            },
            sixDimDecay: () => sixDim.decayTick(),
            sixDimSnapshot: () => sixDim.value,
        });
        this.scheduler.start();
    }
    async onEvent(event) {
        if (this.bridge === null || this.emoji === null || this.client === null)
            return;
        try {
            if (event.post_type === 'message'
                && event.message_type === 'group'
                && this.config.groupEnabled !== false
                && this.config.emoji.steal
                && this.config.primaryGroup !== null
                && event.group_id === this.config.primaryGroup
                && parseInbound(event).imageUrls.length > 0) {
                {
                    const entry = await this.emoji.steal(event);
                    if (entry !== null && this.emojiLibrary !== null && this.client !== null) {
                        const refs = parseInbound(event).imageUrls;
                        void (async () => {
                            try {
                                const url = refs[0];
                                if (url === undefined)
                                    return;
                                const res = await fetch(url);
                                if (!res.ok)
                                    return;
                                const buf = Buffer.from(await res.arrayBuffer());
                                const mediaType = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
                                await this.emojiLibrary?.tagEntry(this.ctx, entry, buf, mediaType);
                                await this.emojiLibrary?.save();
                            }
                            catch { /* best-effort */ }
                        })();
                    }
                }
            }
            if (event.post_type === 'notice') {
                await this.bridge.handleNotice(event);
                return;
            }
            // 好友请求/群邀请预警：不自动同意，转给主人（主人 QQ 客户端里手点即可）
            if (event.post_type === 'request' && this.bridge !== null && this.dmGate !== null) {
                const what = event.request_type === 'friend'
                    ? `好友请求：QQ${event.user_id ?? '?'}（验证消息：${event.comment ?? '无'}）`
                    : event.request_type === 'group'
                        ? `群邀请：QQ${event.user_id ?? '?'} 邀请进群 ${event.group_id ?? '?'}（验证消息：${event.comment ?? '无'}）`
                        : `未知请求类型：${event.request_type ?? '?'}`;
                void this.dmGate.alert('【安全预警】收到' + what + '。插件不自动同意——请在 QQ 里手动处理；同意后好友会自动获得私聊通行。', 'request-' + (event.request_type ?? '?') + '-' + (event.user_id ?? '') + '-' + (event.group_id ?? ''));
                return;
            }
            if (event.post_type !== 'message')
                return;
            await this.bridge.handleEvent(event);
        }
        catch (error) {
            this.ctx.logger.error(`channel-qq: event handling failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
export default ChannelQQ;
