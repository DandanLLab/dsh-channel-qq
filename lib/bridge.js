/** Conversation bridge: OneBot events in, agent sessions, replies back out.
 *
 * One stable session per conversation (group or DM peer), so history resumes
 * across process restarts.
 *
 * Group traffic is batched to keep the agent's inbox from queueing one turn
 * per message: every message lands in a per-conversation intake queue, and one
 * "data packet" (context + messages) is analyzed once per quiet window. An @
 * (or keyword call) skips the wait entirely and flushes the packet — queued
 * context included, since a call is often about what was just said.
 *
 * Outbound is TOOL-ONLY: the agent speaks exclusively through its qq_* send
 * tools, so reasoning and process narration physically cannot reach the group.
 *
 * Vision: inbound images are downloaded and attached to the packet through the
 * harness attachment service, so multimodal models see them natively.
 *
 * Pokes: group pokes are counted with a patience window; only when the
 * patience runs out does 我 poke back and (optionally) vent.
 *
 * Quotes: a reply-reference pulls the referenced message text into the packet
 * (MaiBot-style flexible quote context).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
function defaultDshHome() {
    return process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
}
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
import { parseInbound, rawText } from './segments.js';
import { asSessionId } from './services.js';
import { timeContext } from './scheduler.js';
import { SentLog } from './sent-log.js';
import { transcribeVoiceMessage } from './stt.js';
/** Shared gateway backoff: while active, non-urgent batches wait instead of hammering. */
let gatewayBackoffUntil = 0;
export class ConversationBridge {
    ctx;
    config;
    client;
    out;
    log;
    get persona() {
        return this.config.persona;
    }
    conversations = new Map();
    ensureInFlight = new Map();
    /** Poke patience counters per group. */
    pokes = new Map();
    /** Per-conversation outbound message logs (quote-chain memory). */
    sentLogs = new Map();
    /** Multi-dimensional emotional state (stage-2 情感深化). */
    emotionEngine = null;
    /** 六维情感账本（亲密/信任/心动/安全/默契/张力），模型自主上报、出站行为暗示。 */
    sixDimEngine = null;
    /** Stage-2 knowledge store: top relevant entries ride with each packet. */
    knowledge = null;
    /** 陌生人私聊门控（dmGate.enabled 时非 admins 私聊先过审）。 */
    dmGate = null;
    workspace = null;
    /** Fired whenever a reply turn is submitted (auto-emoji hook). */
    onReply = null;
    constructor(ctx, config, client, out, log) {
        this.ctx = ctx;
        this.config = config;
        this.client = client;
        this.out = out;
        this.log = log;
    }
    /** Stage-2 auto-retrieval v2（1101 温度生命周期改造）：偏好压顶 + 预算压缩 + 温度排序。 */
    memoryHint(text) {
        if (this.knowledge === null || this.knowledge.size() === 0)
            return '';
        const parts = [];
        // 偏好压顶（engram 拆解）：管理员的纠正=每回合第一行，最多 3 条
        const prefs = this.knowledge.preferences(3);
        if (prefs.length > 0) {
            parts.push('[管理员的长期偏好·优先遵守]' + prefs.map((p) => ` ${p.content}`).join('；'));
        }
        if (text.length < 8)
            return parts.join('\n');
        let hits = [];
        try {
            hits = this.knowledge.search(text, 2);
        }
        catch {
            hits = [];
        }
        if (hits.length > 0) {
            // 渐进披露：一行一条截断预览（≤80 字符），整块预算 400 字符
            const lines = hits.map((h) => `#${h.id}[${h.type}] ${h.content.replace(/\s+/g, ' ').slice(0, 80)}`);
            let block = '[记忆召回·需全文用 kb_deep_search 下钻]';
            for (const l of lines) {
                if (block.length + l.length > 400)
                    break;
                block += '\n' + l;
            }
            parts.push(block);
        }
        return parts.join('\n');
    }
    /** Stage-2 auto-retrieval: most relevant knowledge entries for this packet text. */
    knowledgeHint(text) {
        if (this.knowledge === null || this.knowledge.size() === 0 || text.length < 8)
            return '';
        let hits = [];
        try {
            hits = this.knowledge.search(text, 3);
        }
        catch {
            return '';
        }
        if (hits.length === 0)
            return '';
        return '[知识库自动检索·相关旧知]' + hits.map((h, i) => ` ${i + 1})${h.content}`).join('；');
    }
    /**
     * 群聊包检索前置（2026-10-06 科技树点亮）：组包前先用 kb 本地向量检索捞历史相关话题,
     * 与关键词命中合并。同步关键词为主路,向量 presearch 为前置路;2 秒超时永不阻塞组包。
     */
    async knowledgeHintPre(text) {
        const base = this.memoryHint(text);
        if (text.length < 8)
            return base;
        const { execFile } = await import('node:child_process');
        const kbHint = await new Promise((resolve) => {
            try {
                const kbScript = process.env.CHANNEL_QQ_KB_SCRIPT;
                if (!kbScript) {
                    resolve('');
                    return;
                }
                const child = execFile(process.execPath, [kbScript, 'presearch', text.slice(0, 120)], { timeout: 2000, windowsHide: true }, (error, stdout) => {
                    if (error || !stdout)
                        return resolve('');
                    try {
                        const arr = JSON.parse(stdout.trim());
                        if (!Array.isArray(arr) || arr.length === 0)
                            return resolve('');
                        resolve('[向量检索前置·历史相关话题]' + arr.map((x, i) => ` ${i + 1})(${x.file})${x.text.replace(/\s+/g, ' ').slice(0, 90)}`).join('；'));
                    }
                    catch {
                        resolve('');
                    }
                });
                child.on('error', () => resolve(''));
            }
            catch {
                resolve('');
            }
        });
        return [base, kbHint].filter(Boolean).join('\n');
    }
    /**
     * Self-heal workspace membership: every persisted qq-* session is re-attached
     * to the configured workspace at startup, so sessions created before an
     * attach persisted (or dropped by a crash) still group under the workspace.
     */
    async reattachPersistedSessions() {
        try {
            const workspace = await this.ensureWorkspace();
            const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
            const roots = path.join(home, 'sessions');
            const ids = [];
            for (const entry of await fs.readdir(roots, { withFileTypes: true })) {
                if (!entry.isDirectory())
                    continue;
                const dir = path.join(roots, entry.name);
                for (const session of await fs.readdir(dir, { withFileTypes: true })) {
                    if (session.isDirectory() && session.name.startsWith('qq-'))
                        ids.push(session.name);
                }
            }
            let attached = 0;
            for (const id of ids) {
                try {
                    await workspace.attachSession(asSessionId(id));
                    attached += 1;
                    this.log(`self-heal: attached ${id} to workspace`);
                }
                catch (error) {
                    if (!String(error).includes('already exists'))
                        this.log(`self-heal: attach ${id} failed: ${errorChain(error)}`);
                }
            }
            this.log(`self-heal: ${attached}/${ids.length} qq sessions in workspace`);
        }
        catch (error) {
            this.log(`self-heal failed: ${errorChain(error)}`);
        }
    }
    /** Release batch timers when the plugin unloads. */
    dispose() {
        for (const conversation of this.conversations.values()) {
            if (conversation.batchTimer !== null)
                clearTimeout(conversation.batchTimer);
            conversation.batchTimer = null;
            if (conversation.retryTimer !== null)
                clearTimeout(conversation.retryTimer);
            conversation.retryTimer = null;
        }
    }
    /** STT one voice-bar message; failures are logged, never fatal. */
    async transcribeVoice(event, parsed) {
        if (parsed.recordCount === 0 || typeof event.message_id !== 'number')
            return null;
        try {
            const result = await transcribeVoiceMessage(this.client, this.config.stt, event.message_id, this.log);
            if (result === null)
                return null;
            this.log(`voice ${event.message_id} transcribed: ${result[0].slice(0, 60)}`);
            return result[0];
        }
        catch (error) {
            this.log(`voice ${event.message_id} STT failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
    /** Proactive DM: she comes to find the master on her own initiative. */
    async dmProactive(prompt) {
        const master = this.config.admins[0];
        if (master === undefined)
            return;
        const key = `dm-${master}`;
        if (this.config.groupEnabled === false && this.conversations.size === 0) {
            // even with the group off, the DM session still needs to exist
        }
        const synthetic = {
            time: Math.floor(Date.now() / 1000),
            self_id: this.config.selfId,
            post_type: 'message',
            message_type: 'private',
            user_id: master,
            sender: { user_id: master, nickname: this.persona.masterName },
        };
        try {
            const conversation = await this.ensureConversation(key, synthetic);
            if (conversation.pending)
                return;
            const ctx = timeContext();
            this.submit(conversation, `（当前时段：${ctx.period}）
${prompt}`);
            this.log(`dm proactive submitted`);
        }
        catch (error) {
            this.log(`dm proactive failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /** Scheduler hooks: patrol / dream / evolution packets on the group session. */
    async patrolTick(key, prompt) {
        await this.scheduledTick(key, prompt);
    }
    async dreamTick(key, prompt) {
        await this.scheduledTick(key, prompt);
    }
    async evolveTick(key, prompt) {
        await this.scheduledTick(key, prompt);
    }
    async scheduledTick(key, prompt) {
        const conversation = this.conversations.get(key);
        if (conversation === undefined)
            return;
        if (conversation.pending)
            return;
        try {
            await this.ensureConversation(key, conversation.lastEvent);
            const ctx = timeContext();
            this.submit(conversation, `（当前时段：${ctx.period}）
${prompt}`);
            this.log(`scheduled tick submitted for ${key}`);
        }
        catch (error) {
            this.log(`scheduled tick failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /** Download inbound files into the workspace inbox so the agent can process them. */
    async receiveFiles(parsed) {
        if (parsed.files.length === 0)
            return [];
        const saved = [];
        const inbox = path.join(this.config.workspacePath ?? process.cwd(), 'inbox');
        for (const file of parsed.files.slice(0, 3)) {
            try {
                await fs.mkdir(inbox, { recursive: true });
                let bytes = null;
                if (file.url !== '') {
                    const res = await fetch(file.url);
                    if (res.ok)
                        bytes = Buffer.from(await res.arrayBuffer());
                }
                if (bytes === null && file.fileId !== '') {
                    // Fallback: NapCat resolves the file to a local path (or URL).
                    try {
                        const data = await this.client.call('get_file', { file_id: file.fileId }, 20_000);
                        if (typeof data?.file === 'string' && !data.file.startsWith('http')) {
                            bytes = await fs.readFile(data.file).catch(() => null);
                        }
                        else if (typeof data?.file === 'string' && data.file.startsWith('http')) {
                            const res = await fetch(data.file);
                            if (res.ok)
                                bytes = Buffer.from(await res.arrayBuffer());
                        }
                        else if (typeof data?.url === 'string' && data.url !== '') {
                            const res = await fetch(data.url);
                            if (res.ok)
                                bytes = Buffer.from(await res.arrayBuffer());
                        }
                    }
                    catch { /* fall through to error below */ }
                }
                if (bytes === null)
                    throw new Error('no downloadable url');
                const safeName = file.name.replace(/[\/:*?"<>|]/g, '_');
                const target = path.join(inbox, `${Date.now()}_${safeName}`);
                await fs.writeFile(target, bytes);
                saved.push(target);
                this.log(`file received: ${safeName} (${Math.round(bytes.length / 1024)}KB) → inbox`);
            }
            catch (error) {
                this.log(`file ${file.name} download failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return saved;
    }
    // ── notices ────────────────────────────────────────────────────────────────
    /** Group pokes with a patience counter — no instant reaction. */
    async handleNotice(event) {
        if (!this.config.poke.enabled)
            return;
        if (event.notice_type !== 'notify' || event.sub_type !== 'poke')
            return;
        const self = this.client?.selfId ?? this.config.selfId;
        if (event.target_id !== self)
            return;
        const groupId = event.group_id;
        const pokerId = event.user_id;
        if (typeof groupId !== 'number' || typeof pokerId !== 'number')
            return;
        const key = `group-${groupId}`;
        this.log(`poked by QQ${pokerId} in ${groupId} — submitting for agent adjudication`);
        // Adjudication mode: the plugin never pokes or speaks on its own. Every
        // poke targeting the bot is handed to the agent as a notice; it decides
        // whether (and how) to react through its qq_* tools, including
        // qq_send_poke. Rate-limit guard: coalesce only true sticker-tap bursts
        // (pokes landing right after an adjudication was armed). The old version
        // kept a 5-min window that was never cleared, so every poke after the
        // first in each window was silently swallowed.
        const now = Date.now();
        const windowMs = this.config.poke.windowSec * 1000;
        const BURST_MS = 8_000;
        const entry = this.pokes.get(key) ?? { times: [], lastArmedAt: 0 };
        entry.times = entry.times.filter((t) => now - t < windowMs);
        entry.times.push(now);
        this.pokes.set(key, entry);
        if (now - entry.lastArmedAt < BURST_MS) {
            // A pending adjudication is already armed within this burst window.
            return;
        }
        entry.lastArmedAt = now;
        const conversation = this.conversations.get(key);
        if (conversation === undefined || conversation.handle === null)
            return;
        const minutes = Math.max(1, Math.round(this.config.poke.windowSec / 60));
        const prompt = `【戳一戳】QQ${pokerId} 刚刚戳了${this.persona.pronoun}一下（最近 ${minutes} 分钟内第 ${entry.times.length} 次）。是否回应、怎么回应由咱裁决：可以 qq_send_poke 戳回去、qq_send_text 说一句、或者干脆不理。插件不会代替咱行动。`;
        try {
            await this.ensureConversation(key, conversation.lastEvent);
            this.submit(conversation, prompt);
        }
        catch (error) {
            this.log(`poke adjudication failed: ${errorChain(error)}`);
        }
    }
    // ── messages ───────────────────────────────────────────────────────────────
    /** Deterministic call: @-mention or keyword hit (DMs are always direct). */
    isCalled(event, parsed) {
        if (event.message_type === 'private')
            return true;
        if (parsed.isAtBot)
            return true;
        const raw = rawText(event).trim();
        if (raw === '')
            return false;
        for (const keyword of this.config.keywordTriggers) {
            if (raw.includes(keyword))
                return true;
        }
        return false;
    }
    talkChance(conversation) {
        return this.config.primaryGroup !== null && conversation.isGroup && conversation.chatId === this.config.primaryGroup
            ? (this.config.primaryTalkValue ?? this.config.talkValue)
            : this.config.talkValue;
    }
    reactionHint(event) {
        const raw = rawText(event);
        for (const rule of this.config.keywordReactions) {
            if (rule.keywords.some((keyword) => raw.includes(keyword)))
                return rule.reaction;
        }
        return null;
    }
    /** One message line for the intake packet. */
    formatLine(event, parsed, called, quoted, voiceText = null, receivedFiles = []) {
        const senderName = event.sender?.card?.trim() || event.sender?.nickname || `QQ${event.user_id}`;
        const content = parsed.text !== '' ? parsed.text : (parsed.imageUrls.length > 0 ? '[图片]' : null);
        if (content === null && parsed.imageSummaries.length === 0)
            return null;
        const time = new Date((event.time || Math.floor(Date.now() / 1000)) * 1000);
        const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
        const msgId = typeof event.message_id === 'number' ? ` #${event.message_id}` : '';
        // 群身份：群主/管理员/头衔让她知道谁在说话（主人=群主一眼可辨）
        const role = event.sender?.role;
        const roleTag = role === 'owner' ? '[群主]' : role === 'admin' ? '[管理员]' : '';
        const title = event.sender?.title ? `[头衔:${event.sender.title}]` : '';
        const parts = [`${quoted ?? ''}${hhmm} ${senderName}(${event.user_id})${roleTag}${title}${msgId}${called ? ' [@咱]' : ''}：${content ?? '(无文字)'}`];
        if (parsed.atIds.length > 0) {
            const names = parsed.atIds.map((id) => `#${id}`).join('、');
            parts.push(`[@了 ${names}${parsed.isAtBot ? `（含${this.persona.pronoun}）` : `（不是${this.persona.pronoun}）`}]`);
        }
        if (voiceText !== null)
            parts.push(`[语音条说：${voiceText}]`);
        for (const file of receivedFiles)
            parts.push(`[文件已收到，存放在：${file}]`);
        if (parsed.imageSummaries.length > 0)
            parts.push(`[图片含义：${parsed.imageSummaries.join('；')}]`);
        if (called) {
            const hint = this.reactionHint(event);
            if (hint !== null)
                parts.push(`（语气提示：${hint}）`);
        }
        return parts.join('');
    }
    async handleEvent(event) {
        if (event.post_type !== 'message' || event.message_type === undefined)
            return;
        if (event.message_type === 'group' && !this.config.groupEnabled)
            return;
        const key = conversationKey(event);
        if (key === null)
            return;
        const parsed = parseInbound(event);
        // 陌生群预警：机器人在非白名单群收到消息时给主人发预警（本插件不会在这些群发言）
        if (event.message_type === 'group' && typeof event.group_id === 'number' && this.dmGate !== null) {
            const allowed = event.group_id === this.config.primaryGroup || (this.config.extraGroups ?? []).includes(event.group_id);
            if (!allowed) {
                const gid = event.group_id;
                void this.dmGate.alert('【陌生群预警】机器人在未配置的群 ' + gid + ' 收到消息（说话人 QQ' + (event.user_id ?? '?') + '）。若不是你拉的群请检查；可在群设置移除机器人，或把群号加进 extraGroups 放行。', 'group-' + gid);
            }
        }
        // Voice-bar → text so the model hears what was said.
        const voiceText = await this.transcribeVoice(event, parsed);
        // Private-message files land in the workspace inbox for the agent to process.
        const receivedFiles = await this.receiveFiles(parsed);
        // Flexible quote context + vision attachments, prepared for both paths.
        const quoted = await fetchQuoted(this.client, event, parsed, this.log);
        const imageRefs = await attachImages(this.ctx, this.config, this.client, parsed.imageUrls, this.log);
        // 陌生人私聊门控（dmGate.enabled）：非 admins 先过审，未放行不进 agent
        if (event.message_type === 'private' && this.dmGate !== null) {
            const admitted = await this.dmGate.admit(event.user_id ?? 0, event.sender?.nickname ?? '');
            if (!admitted)
                return;
        }
        // DMs stay direct: one message, one immediate analysis.
        if (event.message_type === 'private') {
            const line = this.formatLine(event, parsed, true, quoted, voiceText, receivedFiles);
            if (line === null && imageRefs.length === 0 && receivedFiles.length === 0)
                return;
            const conversation = await this.ensureConversation(key, event);
            // 2026-10-20 owner 令：要能看到bot在打字——私聊回合开始刷"正在输入"，发送完成自动停
            if (event.user_id !== undefined)
                this.out.startTyping(event.user_id);
            // 2026-10-21 owner 令：去掉 [知识库自动检索] 注入——污染上下文（灌全文）。
            // 2026-11-01 温度生命周期改造（管理员令"记忆注入改造"）：以偏好压顶+预算压缩版回归
            // （memoryHint 整块 ≤400 字符；偏好=管理员纠正自动捕获）。群聊维持 10-21 令不注入。
            const adminText = (this.config.admins ?? []).includes(event.user_id ?? 0) ? parsed.text : '';
            if (adminText.length > 0 && this.knowledge !== null) {
                void this.knowledge.captureFromMessage(adminText, `chat:${event.user_id}`).catch(() => { });
            }
            const memHint = await this.knowledgeHintPre(adminText.length > 0 ? adminText : (line ?? ''));
            const text = [line, '（图见附件）'].filter(Boolean).join('\n');
            // 2026-10-13 串窗事故修复（owner 批）：私聊包必须带窗口信标，杜绝模型按惯性发群
            this.submit(conversation, text
                + (memHint !== '' ? `\n${memHint}` : '')
                + `\n【本会话是QQ私聊：QQ${event.user_id}。回复必须 isGroup=false target=${event.user_id}，除非主人明确要求转群。】`
                + '\n（要发言就用 qq_send_text 或 qq_reply_quote 发到本会话；没有要说的话就不调用任何发送工具。）', imageRefs);
            return;
        }
        const conversation = this.conversations.get(key) ?? this.createConversationRecord(key, event);
        conversation.lastEvent = event;
        const called = this.isCalled(event, parsed);
        const line = this.formatLine(event, parsed, called, quoted, voiceText, receivedFiles);
        // Inject mode: every group message reaches the agent's context as it
        // arrives — steer (deliver + wake) when idle so it can reply right away,
        // inject (context-only) while a turn is running so it sees the message at
        // the next step boundary. No batching window, no talk-chance gate.
        if (this.config.injectMode.enabled) {
            if (line === null && imageRefs.length === 0)
                return;
            // History replays every attachment in EVERY request and the provider caps
            // images per request (~16 on many provider pools). Attach images only for
            // direct calls (and never while a turn streams); casual group chat images are
            // still seen through their [图片含义] text summaries.
            const deliverImages = (called && !conversation.pending) ? imageRefs.slice(0, Math.max(1, this.config.imageRecognition.maxPerMessage)) : [];
            await this.injectNow(conversation, event, line, deliverImages, called);
            return;
        }
        if (line !== null) {
            conversation.queue.push(line);
            // 六维情感：由模型 qq_report_emotion 自主上报（2026-10-21 owner 令，不做关键词自动触发）
        }
        if (imageRefs.length > 0) {
            const cap = this.config.imageRecognition.maxPerMessage;
            conversation.pendingImages.push(...imageRefs.slice(-cap));
        }
        // Cross-window dedup: the same QQ message_id must never be queued twice
        // ( NapCat retries and window echoes used to duplicate packets ).
        if (typeof event.message_id === 'number') {
            if (!conversation.seenMessageIds)
                conversation.seenMessageIds = new Set();
            if (conversation.seenMessageIds.has(event.message_id))
                return;
            if (conversation.seenMessageIds.size > 500)
                conversation.seenMessageIds = new Set([...conversation.seenMessageIds].slice(-250));
            conversation.seenMessageIds.add(event.message_id);
        }
        if (called) {
            // Skip the batch window: analyze now, queued context included.
            await this.flushNow(conversation, { immediate: true });
            return;
        }
        if (conversation.queue.length === 0)
            return;
        const { maxMessages, maxChars } = this.config.batching;
        const queuedChars = conversation.queue.reduce((sum, entry) => sum + entry.length, 0);
        if (conversation.queue.length >= maxMessages || queuedChars >= maxChars) {
            this.log(`batch full (${conversation.queue.length} lines, ${queuedChars} chars) — analyzing`);
            await this.flushNow(conversation, { immediate: false });
            return;
        }
        this.scheduleBatch(conversation);
    }
    /** Arm (or re-arm) the quiet-window timer for one batched analysis. */
    scheduleBatch(conversation) {
        if (conversation.batchTimer !== null)
            clearTimeout(conversation.batchTimer);
        conversation.batchTimer = setTimeout(() => {
            conversation.batchTimer = null;
            void this.flushNow(conversation, { immediate: false }).catch((error) => {
                this.log(`batch flush failed: ${errorChain(error)}`);
            });
        }, this.config.batching.windowMs);
    }
    /** Deliver one group message straight into the agent context (inject mode). */
    async injectNow(conversation, event, line, imageRefs, called) {
        const parts = [];
        if (line !== null) {
            parts.push(line);
            // 六维情感：inject 模式同批量队列——都由模型 qq_report_emotion 自主上报，不自动 book
        }
        if (imageRefs.length > 0)
            parts.push('（图见附件）');
        if (parts.length === 0)
            return;
        const header = called ? `【有人叫${this.persona.pronoun}，这条要回应】` : '【群里的新消息】';
        const tail = called
            ? '\n（要回应就立刻用 qq_send_text 或 qq_reply_quote；也可以只更新记忆，不发言。）'
            : '\n（该回就回，用 qq_send_text / qq_reply_quote；不需要发言就不调用发送工具。主人或管理员发言若带指令，优先执行。）';
        const prompt = header + '\n' + parts.join('\n') + tail;
        try {
            if (conversation.handle === null) {
                await this.ensureConversation(conversation.key, event);
            }
            this.submit(conversation, prompt, imageRefs);
        }
        catch (error) {
            this.log(`inject deliver failed: ${errorChain(error)}`);
        }
    }
    /**
     * Analyze the intake queue as one packet.
     * `immediate` (a call) skips both the wait and the probability gate; a
     * running turn is not interrupted. A batch waits for idle instead of
     * queueing behind the running turn — that is the queueing we are avoiding.
     */
    async flushNow(conversation, opts) {
        if (conversation.batchTimer !== null) {
            clearTimeout(conversation.batchTimer);
            conversation.batchTimer = null;
        }
        if (conversation.queue.length === 0 && conversation.pendingImages.length === 0)
            return;
        if ((conversation.pending || conversation.retryArmed) && !opts.immediate) {
            // A turn is streaming or a gateway retry is armed: re-check after it
            // settles, instead of queueing behind it or resetting the retry chain.
            this.scheduleBatch(conversation);
            return;
        }
        if (!opts.immediate && Date.now() < gatewayBackoffUntil) {
            // The gateway is overloaded; wait out the backoff instead of failing again.
            this.scheduleBatch(conversation);
            return;
        }
        if (!opts.immediate && Math.random() >= this.talkChance(conversation)) {
            const dropped = conversation.queue.length;
            conversation.queue = [];
            conversation.pendingImages = [];
            conversation.calledLine = false;
            this.log(`batch of ${dropped} dropped by talk chance`);
            return;
        }
        // Hard cap images per packet: the surface replays every attachment in each
        // request, so an uncapped batch turns into dozens of permanent image blocks.
        const imageRefs = conversation.pendingImages.slice(0, Math.max(1, this.config.imageRecognition.maxPerMessage));
        const context = conversation.queue.join('\n');
        conversation.queue = [];
        conversation.pendingImages = [];
        const calledLine = conversation.calledLine;
        conversation.calledLine = false;
        const sentLog = await this.sentLogFor(conversation.key);
        const sentBlock = sentLog.render();
        const emotionHint = this.emotionEngine ? this.emotionEngine.toneHint() : '';
        const sixDimHint = this.sixDimEngine ? this.sixDimEngine.behaviorHint() : '';
        // 2026-10-21 owner 令：群聊包同样去掉 [知识库自动检索] 注入（检索由她自己用工具做）
        const prompt = (calledLine
            ? `【刚才群里的消息，最后一条[@${this.persona.pronoun}]是叫${this.persona.pronoun}】：\n${context}\n（结合上下文接话）`
            : `【最近时段群里的消息】：\n${context}\n（一轮只回一次，有聊头就接一句）`)
            + `
（当前时段：${timeContext().period}）`
            + (emotionHint !== '' ? `\n${emotionHint}` : '')
            + (sixDimHint !== '' ? `\n（六维情感行为暗示：${sixDimHint}）` : '')
            + (sentBlock !== '' ? `\n${sentBlock}` : '')
            + '\n（每条消息带#编号。要指名回应某条就用 qq_reply_quote 引用那条；一般发言用 qq_send_text；想配表情包就先 qq_list_emojis 挑一张再用 qq_send_emoji 发，必须贴合群氛围，拿不准就不发；没有要说的话就不调用任何发送工具。决定沉默时直接结束回合——绝不调用发送工具，更绝不把"本轮不发/沉默/守则/战况分析"之类的内部盘算当成消息发出去，群里只许出现真正要说的那句话。）';
        try {
            if (conversation.handle === null) {
                await this.ensureConversation(conversation.key, conversation.lastEvent);
            }
            this.submit(conversation, prompt, imageRefs);
        }
        catch (error) {
            this.log(`bridge followup failed: ${errorChain(error)}`);
        }
    }
    createConversationRecord(key, event) {
        const conversation = {
            key,
            sessionId: asSessionId(`qq-${key}`),
            isGroup: event.message_type === 'group',
            chatId: (event.group_id ?? event.user_id) ?? 0,
            handle: null,
            pending: false,
            queue: [],
            pendingImages: [],
            seenMessageIds: new Set(),
            batchTimer: null,
            calledLine: false,
            lastPrompt: null,
            retryCount: 0,
            retryArmed: false,
            liveSubmitted: false,
            retryTimer: null,
            turnErrored: false,
            lastPromptHadImages: false,
            textOnlyRetryDone: false,
            lastEvent: event,
        };
        this.conversations.set(key, conversation);
        return conversation;
    }
    async ensureConversation(key, event) {
        const pending = this.ensureInFlight.get(key);
        if (pending !== undefined) {
            return pending;
        }
        const run = this.ensureConversationInner(key, event).finally(() => {
            this.ensureInFlight.delete(key);
        });
        this.ensureInFlight.set(key, run);
        return run;
    }
    async ensureConversationInner(key, event) {
        const existing = this.conversations.get(key);
        if (existing !== undefined && existing.handle !== null)
            return existing;
        const sessionId = asSessionId(`qq-${key}`);
        const workspace = await this.ensureWorkspace();
        const presets = this.ctx.agentPresets;
        const preset = await presets.resolve(this.config.agentPreset);
        // alpha.5 适配（E 阶段）：rc.2 的 standingKeyFor(id)（预热 standing mount 并返回 scope key）
        // 在 alpha.5 registry 改名为 acquireScope(id)（retain 生成代 + scope key，AsyncDisposable）。
        // 预热语义等价；返回的 scope 不落盘、即弃——这里只需要挂载预热副作用。
        const standing = presets.acquireScope !== undefined
            ? presets.acquireScope(preset.id)
            : presets.standingKeyFor?.(preset.id);
        if (standing !== undefined)
            await standing;
        const defaultSelection = this.ctx.agentDefaultModel.currentSelection();
        const conversation = this.conversations.get(key) ?? this.createConversationRecord(key, event);
        // 群聊走 groupModel 路由（可配置的轻量快模型），私聊走默认路由
        const selection = conversation.isGroup
            && this.config.groupModel.provider !== null
            && this.config.groupModel.model !== null
            ? { provider: this.config.groupModel.provider, model: this.config.groupModel.model }
            : defaultSelection;
        const createOptions = {
            meta: { cwd: workspace.path, agentPreset: preset.id },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: async (agentCtx) => {
                await presets.mount(agentCtx, preset.id);
                attachTurnWatch(agentCtx, conversation, this.log);
            },
        };
        const agents = this.ctx.agents;
        let handle = null;
        this.log(`ensureConversation key=${key} sessionId=${String(sessionId)} live=${String(agents.get(sessionId) !== undefined)}`);
        const live = agents.get(sessionId);
        if (live !== undefined) {
            // The persisted composition already carries the preset; remounting is
            // rejected by the scope binding, so resume as-is and re-attach the
            // turn watch the original setup() hook can no longer provide.
            if (live.ctx !== undefined) {
                attachTurnWatch(live.ctx, conversation, this.log);
                // Every resume re-installs: the Web UI or stale request headers can
                // silently swap routes between turns.
                installModelOverride(live.ctx, selection);
            }
            handle = { agent: live };
            this.log(`resumed session ${sessionId} for ${key} (route ${selection.provider}/${selection.model})`);
        }
        else {
            try {
                handle = await agents.create({ ...createOptions, sessionId });
            }
            catch (createError) {
                // The session id is persisted from an earlier run: rehydrate its
                // history as a live agent instead of failing the batch.
                this.log(`create failed for ${String(sessionId)}: ${errorChain(createError).slice(0, 200)}`);
                if (!String(createError).includes('already exists'))
                    throw createError;
                // The bulk reattach may still be publishing this session; a resume in
                // that window can fail with a registry mismatch. Retry twice on a
                // short backoff before giving up.
                let resumed = false;
                let lastResumeError = createError;
                for (let attempt = 0; attempt < 3 && !resumed; attempt++) {
                    try {
                        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
                        const liveAgain = agents.get(sessionId);
                        if (liveAgain !== undefined) {
                            if (liveAgain.ctx !== undefined)
                                attachTurnWatch(liveAgain.ctx, conversation, this.log);
                            handle = { agent: liveAgain };
                            resumed = true;
                            this.log(`resumed session ${sessionId} (retry ${attempt + 1}, live registry)`);
                        }
                        else {
                            // resume() is a separate registry method — create() with a
                            // resumeSessionId mints a fallback "session-N" identity and
                            // fails the agent-id match.
                            handle = await agents.resume({
                                resumeSessionId: sessionId,
                                agentOptions: createOptions.agentOptions,
                                setup: createOptions.setup,
                            });
                            resumed = true;
                            this.log(`resumed persisted session ${sessionId} (retry ${attempt + 1})`);
                        }
                    }
                    catch (resumeError) {
                        lastResumeError = resumeError;
                        this.log(`resume retry ${attempt + 1} failed: ${errorChain(resumeError).slice(0, 120)}`);
                    }
                }
                if (!resumed)
                    throw lastResumeError;
            }
            if (handle === null)
                throw new Error(`ensureConversation: no handle for ${String(sessionId)}`);
        }
        conversation.handle = handle;
        // Re-attaching a persisted session already bound to the workspace throws;
        // the attachment survives restarts, so treat that as success.
        try {
            await workspace.attachSession(sessionId);
        }
        catch (error) {
            if (!String(error).includes('already exists'))
                throw error;
            this.log(`session ${sessionId} already attached to workspace`);
        }
        // 权限分层（主人 1001 令"私聊窗口全部权限"）：私聊=danger-full-access，
        // 群聊=维持配置的 workspace-write（自我工作区权限不提权）。
        const permissionPreset = conversation.isGroup ? this.config.permissionPreset : 'danger-full-access';
        this.ctx.permissionPresets.set(handle.agent.session, permissionPreset);
        this.ctx.sessionTitle.rename(handle.agent.session, event.message_type === 'group' ? `QQ 群${event.group_id}` : `QQ 私聊${event.user_id}`);
        this.conversations.set(key, conversation);
        this.log(`session ${sessionId} ready for ${key}`);
        return conversation;
    }
    /** Master-only admin prompt: submit one packet into the master's DM session. */
    async adminPrompt(prompt) {
        const master = this.config.admins[0];
        if (master === undefined)
            throw new Error('no admin configured');
        const key = `dm-${master}`;
        const synthetic = {
            time: Math.floor(Date.now() / 1000),
            self_id: this.config.selfId,
            post_type: 'message',
            message_type: 'private',
            user_id: master,
            sender: { user_id: master, nickname: '主人' },
        };
        const conversation = await this.ensureConversation(key, synthetic);
        if (conversation.pending)
            throw new Error('turn in flight; try again shortly');
        this.submit(conversation, prompt);
        this.log(`admin prompt submitted to ${key}`);
    }
    async sentLogFor(key) {
        let log = this.sentLogs.get(key);
        if (log === undefined) {
            log = new SentLog(defaultDshHome(), key, this.log);
            await log.load();
            this.sentLogs.set(key, log);
        }
        return log;
    }
    async ensureWorkspace() {
        if (this.workspace !== null)
            return this.workspace;
        const path = this.config.workspacePath;
        if (path === null || path === '')
            throw new Error('channel-qq: workspacePath is not configured');
        this.workspace = await this.ctx.workspaceRegistry.create(path);
        return this.workspace;
    }
    submit(conversation, prompt, imageRefs = []) {
        // A fresh packet supersedes any armed gateway retry for the old one.
        clearGatewayRetry(conversation);
        conversation.pending = true;
        conversation.lastPrompt = prompt;
        conversation.retryCount = 0;
        conversation.turnErrored = false;
        const content = [{ type: 'text', text: prompt }];
        for (const attachment of imageRefs)
            content.push({ type: 'image', attachment });
        conversation.lastPromptHadImages = imageRefs.length > 0;
        conversation.textOnlyRetryDone = false;
        const message = createUserMessage({ content, source: { kind: 'channel-qq', form: 'message' } });
        const agent = conversation.handle.agent;
        const injectDelivery = this.config.injectMode.enabled;
        if (injectDelivery) {
            // Running turn: inject without waking — the driver claims it at the next
            // step boundary, inside the current turn. Idle: steer so the agent wakes
            // and answers now (fall back to followup on older runtimes).
            const agentRecord = agent;
            const running = agentRecord.status === 'running';
            if (running) {
                if (typeof agentRecord.inject === 'function')
                    agentRecord.inject(message);
                else
                    agent.followup(message);
            }
            else if (this.config.injectMode.wakeIdle) {
                if (typeof agentRecord.steer === 'function')
                    agentRecord.steer(message);
                else
                    agent.followup(message);
            }
            else {
                if (typeof agentRecord.inject === 'function')
                    agentRecord.inject(message);
                else
                    agent.followup(message);
            }
        }
        else {
            agent.followup(message);
        }
        conversation.liveSubmitted = true;
        this.onReply?.(conversation.isGroup, conversation.chatId);
    }
}
/**
 * Force the current default route onto a resumed session: its persisted
 * request header still names the provider/model from previous runs (which may
 * be retired upstream), so every request is re-pointed here. The Web UI can
 * still override per session by changing the default while no turn runs.
 */
function installModelOverride(agentCtx, selection) {
    const events = agentCtx;
    events.on('agent/request', ((payload, next) => {
        return next().then((resolved) => {
            if (resolved.provider === selection.provider && resolved.model === selection.model)
                return resolved;
            return { ...resolved, provider: selection.provider, model: selection.model };
        });
    }));
}
/** Track turn lifecycle per conversation (batch waiting + error visibility). */
function attachTurnWatch(agentCtx, conversation, log) {
    // Emit-mode events deliver a single payload and ignore the listener's return.
    const events = agentCtx;
    events.on('agent/status', ((payload) => {
        if (payload?.status !== 'idle')
            return;
        if (conversation.pending || conversation.liveSubmitted) {
            conversation.pending = false;
            conversation.liveSubmitted = false;
            log?.(`turn done for ${conversation.key}`);
        }
        if (!conversation.turnErrored) {
            // Clean turn: the packet made it through, so no retry chain is needed.
            clearGatewayRetry(conversation);
            return;
        }
        // Failed turn: keep the armed retry chain, reset the per-turn marker.
        conversation.turnErrored = false;
    }));
    events.on('agent/error', ((payload) => {
        const raw = JSON.stringify(payload?.error ?? payload, (k, v) => (k === 'message' || k === 'name' || typeof v !== 'object' ? v : undefined));
        log?.(`agent error: ${raw.slice(0, 400)}`);
        // Gateway-shaped failures (overload / rate limit / transient): the packet
        // is already in session history, so re-drive it after a backoff instead
        // of losing the batch. Permanent request errors are not retried here.
        // Image-bearing request rejected outright (count/size/vision-outage): the
        // conversation text is intact, so retry once text-only instead of losing the turn.
        const imageShapedFailure = (raw.includes('"INVALID_REQUEST"') || raw.includes('"SERVER"'))
            && conversation.lastPromptHadImages
            && !conversation.textOnlyRetryDone;
        if (imageShapedFailure && conversation.handle !== null && conversation.lastPrompt !== null) {
            conversation.textOnlyRetryDone = true;
            conversation.turnErrored = false;
            conversation.pending = true;
            log?.(`image request rejected; retrying text-only for ${conversation.key}`);
            const message = createUserMessage({
                content: [{ type: 'text', text: GATEWAY_RETRY_NUDGE }],
                source: { kind: 'channel-qq', form: 'message' },
            });
            conversation.handle.agent.followup(message);
            return;
        }
        const retriable = ['SERVER', 'RATE_LIMIT', 'PI_AI_ERROR', 'TIMEOUT']
            .some((code) => raw.includes(`"${code}"`));
        if (!retriable || conversation.handle === null)
            return;
        if (conversation.lastPrompt === null)
            return;
        if (conversation.retryTimer !== null)
            return; // one retry chain per failure window
        if (conversation.retryCount >= GATEWAY_RETRY_MAX) {
            log?.(`turn for ${conversation.key} exhausted ${GATEWAY_RETRY_MAX} gateway retries; giving up`);
            clearGatewayRetry(conversation);
            conversation.lastPrompt = null;
            return;
        }
        conversation.turnErrored = true;
        conversation.retryArmed = true;
        conversation.retryCount += 1;
        const attempt = conversation.retryCount;
        const delay = gatewayBackoffMs(attempt);
        gatewayBackoffUntil = Math.max(gatewayBackoffUntil, Date.now() + delay);
        log?.(`scheduling gateway retry ${attempt}/${GATEWAY_RETRY_MAX} for ${conversation.key} in ${Math.round(delay / 1000)}s`);
        conversation.retryTimer = setTimeout(() => {
            conversation.retryTimer = null;
            if (conversation.handle === null || !conversation.lastPrompt)
                return;
            log?.(`retry ${attempt}/${GATEWAY_RETRY_MAX} for ${conversation.key}`);
            conversation.pending = true;
            conversation.handle.agent.followup(createUserMessage({
                content: [{ type: 'text', text: GATEWAY_RETRY_NUDGE }],
                source: { kind: 'channel-qq', form: 'message' },
            }));
        }, delay);
    }));
}
/** Gateway retry policy: total attempts before the packet is dropped. */
const GATEWAY_RETRY_MAX = 8;
const GATEWAY_RETRY_NUDGE = '（刚才网关过载，那次分析失败了）请接着分析处理上面的消息，并用工具发言。';
/** Exponential gateway backoff: 30s doubling to a 3min cap, ±20% jitter. */
function gatewayBackoffMs(attempt) {
    const base = Math.min(30_000 * 2 ** (attempt - 1), 180_000);
    return Math.round(base * (0.8 + Math.random() * 0.4));
}
/** Cancel an armed gateway-retry chain (success, fresh packet, or unload). */
function clearGatewayRetry(conversation) {
    if (conversation.retryTimer !== null)
        clearTimeout(conversation.retryTimer);
    conversation.retryTimer = null;
    conversation.retryArmed = false;
}
// ── bridge helpers ───────────────────────────────────────────────────────────
/** Pull the referenced message (flexible quote context) into a prefix. */
async function fetchQuoted(client, event, parsed, log) {
    if (parsed.replyToMessageId === null)
        return null;
    try {
        const data = await client.call('get_msg', { message_id: parsed.replyToMessageId }, 8000);
        const text = (data.raw_message ?? (data.message !== undefined ? parseInbound({ message: data.message }).text : '')).trim();
        const who = data.sender?.card?.trim() || data.sender?.nickname || `QQ${data.sender?.user_id ?? '?'}`;
        if (text === '') {
            log?.(`quoted msg ${parsed.replyToMessageId}: fetched but empty text`);
            return null;
        }
        log?.(`quoted msg ${parsed.replyToMessageId} from ${who}: ${text.slice(0, 60)}`);
        return `[引用 ${who}(${data.sender?.user_id ?? '?'}）：${text.slice(0, 120)}] `;
    }
    catch (error) {
        log?.(`quoted msg ${parsed.replyToMessageId} fetch failed: ${errorChain(error)}`);
        return null;
    }
}
/** Download and durably store inbound images for the vision prompt. */
async function attachImages(ctx, config, client, urls, log) {
    if (!config.imageRecognition.enabled)
        return [];
    const refs = [];
    for (const url of urls.slice(0, config.imageRecognition.maxPerMessage)) {
        try {
            const bytes = await downloadImage(client, url);
            if (bytes === null)
                continue;
            const mediaType = sniffMediaType(bytes);
            const ref = await (ctx.attachments).saveImage({ data: bytes, mediaType, name: `qq-image.${mediaType.slice(6)}` });
            refs.push(ref);
            log(`image attached (${Math.round(bytes.length / 1024)} KB, ${mediaType})`);
        }
        catch (error) {
            log(`image attach failed: ${errorChain(error)}`);
        }
    }
    return refs;
}
async function downloadImage(client, url) {
    if (url !== '') {
        const res = await fetch(url);
        if (res.ok)
            return new Uint8Array(await res.arrayBuffer());
    }
    // Fallback: ask NapCat for the local file (same machine).
    try {
        const data = await client.call('get_image', { file: url }, 15_000);
        if (typeof data?.file === 'string')
            return new Uint8Array(await fs.readFile(data.file));
    }
    catch {
        // fall through
    }
    return null;
}
/** Image media type from magic bytes; attachments validate against decoded bytes. */
function sniffMediaType(bytes) {
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50)
        return 'image/png';
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8)
        return 'image/jpeg';
    if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
        return 'image/gif';
    if (bytes.length > 12 && bytes[0] === 0x52 && bytes[8] === 0x57 && bytes[9] === 0x45)
        return 'image/webp';
    return 'image/jpeg';
}
function conversationKey(event) {
    if (event.message_type === 'group' && typeof event.group_id === 'number')
        return `group-${event.group_id}`;
    if (event.message_type === 'private' && typeof event.user_id === 'number')
        return `dm-${event.user_id}`;
    return null;
}
