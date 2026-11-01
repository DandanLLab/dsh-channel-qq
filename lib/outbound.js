/** Outbound pipeline: segmentation, rate limiting, and length caps. Ported from an earlier OneBot extension. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
/**
 * Hard-split one overlong segment at natural boundaries (ported from the
 * extension's smartSplitMessage): newline first, then sentence punctuation,
 * then a hard cut. Keeps every chunk under the OneBot-safe limit.
 */
export function smartSplitMessage(text, limit) {
    const { text: guarded, urls } = protectUrls(text);
    if (guarded.length <= limit)
        return [restoreUrls(guarded, urls)];
    const chunks = [];
    let remaining = guarded;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        let splitPos = remaining.lastIndexOf('\n', limit);
        if (splitPos < limit * 0.5) {
            splitPos = Math.max(remaining.lastIndexOf('。', limit), remaining.lastIndexOf('！', limit), remaining.lastIndexOf('？', limit), remaining.lastIndexOf('!', limit), remaining.lastIndexOf('?', limit), remaining.lastIndexOf('. ', limit), remaining.lastIndexOf('；', limit), remaining.lastIndexOf('; ', limit), remaining.lastIndexOf(', ', limit), remaining.lastIndexOf('，', limit));
            if (splitPos <= 0)
                splitPos = limit;
        }
        chunks.push(remaining.slice(0, splitPos + 1).trim());
        remaining = remaining.slice(splitPos + 1).trim();
    }
    return chunks.filter((chunk) => chunk !== '').map((chunk) => restoreUrls(chunk, urls));
}
/** Junk the model sometimes emits; never sent to the group (ported from an earlier OneBot extension). */
const JUNK_PATTERNS = [
    /这些是重复发送的内容/i,
    /NO_REPLY/i,
    /^Something went wrong while processing your request/i,
    /^Please try again, or use \/new to start a fresh session/i,
    /^.*terminated.*$/i,
    /^GitHub\s*-\s*.+·\s*GitHub\s*$/i,
    /Contribute to .+ development by creating an account on GitHub/i,
    /未解析到有效文本内容/,
    /生成任务失败/,
];
function stripJunk(text) {
    let filtered = text;
    // 模型输出字面 反斜杠n 时解成真换行（有些路由会把换行转义成字面量）
    filtered = filtered.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, ' ');
    for (const pattern of JUNK_PATTERNS) {
        filtered = filtered.replace(pattern, '');
    }
    filtered = filtered.replace(/<思考>[\s\S]*?<\/思考>/g, '');
    filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    filtered = filtered.replace(/[（(][\d一二三四五六七八九十百千万]+字[）)]/g, '');
    const seen = new Set();
    filtered = filtered.replace(/https?:\/\/github\.com\/[^\s]+/gi, (match) => (seen.has(match) ? '' : (seen.add(match), match)));
    return filtered.trim();
}
/** URL 保护（2026-10-20 owner 令：链接永不被切断）：
 * 标点转换（:→：）与句读切分都会腰斩链接。切分/转换前把 URL 换成私有区占位符
 * （无标点无空格，任何切分器都咬不动），切完再还原。尾部中文标点留在 URL 外。 */
const URL_RE = /https?:\/\/[^\s"'）】》」【【]+/g;
function protectUrls(text) {
    const urls = [];
    const protectedText = text.replace(URL_RE, (match) => {
        const trimmed = match.replace(/[。，！？；、）】》」]+$/, '');
        const suffix = match.slice(trimmed.length);
        const token = `\uE000${urls.length}\uE001`;
        urls.push(trimmed);
        return token + suffix;
    });
    return { text: protectedText, urls };
}
function restoreUrls(chunk, urls) {
    return chunk.replace(/\uE000(\d+)\uE001/g, (_, i) => urls[Number(i)] ?? '');
}
/** English punctuation → fullwidth; straight quotes → curly pairs. */
function convertPunctuation(text) {
    let result = text.replace(/:/g, '：').replace(/,/g, '，').replace(/\?/g, '？').replace(/!/g, '！');
    let open = true;
    let converted = '';
    for (const char of result) {
        if (char === '"') {
            converted += open ? '“' : '”';
            open = !open;
        }
        else
            converted += char;
    }
    return converted;
}
/**
 * Rule-based segmentation ported from an earlier OneBot extension's smartSegmenter:
 * 段数由句号说了算 — every sentence ender (。！？…!?) outside protected regions
 * (code blocks, --- blocks, quotes, brackets) starts a new segment. Emotional
 * punctuation is kept, trailing 。 is dropped, duplicates removed, and the
 * style knob tunes rhythm: conservative merges tiny adjacent sentences,
 * active keeps every sentence as its own message.
 */
/** 2026-10-25 owner 令：句尾不带句号=硬规矩——每条气泡出口统一剥句尾句号（中间句号保留当分隔）。 */
function stripTrailingPeriods(pieces) {
    return pieces.map((p) => p.replace(/[。]+\s*$/, '').trim()).filter((p) => p !== '');
}
export function segmentReply(text, config) {
    const { enabled, style, maxSegments, removeTrailingPeriod } = config.segmentation;
    let body = stripJunk(text);
    if (!enabled || body === '')
        return body === '' ? [] : stripTrailingPeriods([body]);
    // 2026-10-20 owner 令：链接永不被切断——标点转换与切分前先保护 URL
    const { text: protectedBody, urls } = protectUrls(body);
    body = convertPunctuation(protectedBody);
    // 2026-09-29 owner 令：按换行符分段（人打字自然分行）
    // 2026-10-06 owner 令二改：分段只认换行，没有换行就整条发，禁止再按句号自动切片
    //（12:43 主人定案：一句号切一条=连发刷屏，太机器。真人一条就是一条，换行才分段）
    const paraSplit = body.split(/\n{1,}/).map((s) => s.trim()).filter((s) => s !== '');
    if (paraSplit.length > 1) {
        return stripTrailingPeriods(paraSplit.slice(0, maxSegments).map((s) => restoreUrls(s, urls)));
    }
    // 无换行：整条返回（超长由 smartSplitMessage 兜底，只防撞 OneBot 上限）
    return stripTrailingPeriods([restoreUrls(body, urls)]);
}
/** Serialises sends so the configured rate limit holds across segments and tools. */
export class OutboundQueue {
    client;
    config;
    log;
    chain = Promise.resolve();
    /** Every segment ever sent, keyed lowercase — a repeat is skipped (sentMessages). */
    sentHistory = new Set();
    constructor(client, config, log) {
        this.client = client;
        this.config = config;
        this.log = log;
    }
    typingTimers = new Map();
    typingCaps = new Map();
    // 2026-10-25 owner 令：QQ 必须收到完整消息——补发仍败的分段持久化到 outbox-pending，
    // 60s 重驱循环重发直到清空；上限保护=仍走串行队列与 rateLimitMs，不新增并发。
    pendingDir = 'D:/dsh-data/outbox-pending';
    pendingRedrive = null;
    persistPending(action, payload) {
        try {
            fs.mkdirSync(this.pendingDir, { recursive: true });
            const file = `${this.pendingDir}/pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
            fs.writeFileSync(file, JSON.stringify({ action, payload }));
            this.log(`pending saved: ${path.basename(file)} (${action})`);
        }
        catch (e) {
            this.log(`pending persist failed: ${e.message}`);
        }
    }
    startPendingRedrive() {
        if (this.pendingRedrive !== null)
            return;
        this.pendingRedrive = setInterval(() => {
            let files = [];
            try {
                files = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith('.json'));
            }
            catch {
                return;
            }
            if (files.length === 0)
                return;
            this.log(`pending redrive: ${files.length} 条待补`);
            for (const f of files) {
                const full = `${this.pendingDir}/${f}`;
                try {
                    const { action, payload } = JSON.parse(fs.readFileSync(full, 'utf8'));
                    fs.unlinkSync(full);
                    this.enqueue(() => this.client.call(action, payload), () => `[redrive] ${action} ${JSON.stringify(payload).slice(0, 120)}`);
                }
                catch (e) {
                    this.log(`pending redrive read fail ${f}: ${e.message}`);
                }
            }
        }, 60000);
    }
    /** Queue one send; trailing nullish segments are skipped silently.
     * 2026-10-20 owner 令：没发出去的延时补发，确保全文完整——失败重试 1+3 次（退避 2/5/10s），
     * 重试耗尽仍失败的全文写入 dead letter 留档，绝不静默丢失。 */
    enqueue(send, describe, onGiveUp) {
        this.chain = this.chain
            .then(() => new Promise((resolve) => setTimeout(resolve, this.config.rateLimitMs)))
            .then(() => this.sendWithRetry(send))
            .catch((error) => {
            const note = describe ? this.deadLetter(describe()) : '';
            this.log(`send failed (重试耗尽): ${error.message}${note ? ' | 全文已留档: ' + note : ''} | 10s 后补发一轮`);
            // owner 令：分段的没发出去的要重新发回来——60s 后补发一整轮，仍败才留档
            return new Promise((resolve) => setTimeout(resolve, 10000)).then(async () => {
                try {
                    await this.sendWithRetry(send);
                    this.log('send rescued: 补发成功');
                }
                catch (error2) {
                    const note2 = describe ? this.deadLetter('[补发仍败] ' + describe()) : '';
                    this.log(`send rescued-failed: ${error2.message}${note2 ? ' | 全文已留档: ' + note2 : ''}`);
                    // 完整送达保证：仍败的分段持久化 + 重驱循环，直到 QQ 收全
                    const giveUp = onGiveUp?.();
                    if (giveUp)
                        this.persistPending(giveUp.action, giveUp.payload);
                    this.startPendingRedrive();
                }
            });
        })
            .then(() => { });
    }
    async sendWithRetry(send, attempts = 4) {
        const delays = [2000, 5000, 10000];
        let lastError;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                return await send();
            }
            catch (error) {
                lastError = error;
                if (attempt < attempts - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delays[Math.min(attempt, delays.length - 1)]));
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    deadLetter(text) {
        try {
            const file = `${process.env.TMPDIR ?? process.env.TEMP ?? os.tmpdir()}/outbound-dead-letter.log`;
            fs.appendFileSync(file, new Date().toISOString() + '\n' + text + '\n---\n');
            return file;
        }
        catch {
            return '';
        }
    }
    /** 思考期"正在输入"循环（owner 令：要能看到bot在打字）：私聊回合开始刷起，
     *  5s 一拍续命（QQ 输入态几秒就过期），发送完成自动停，10 分钟硬上限防失控。 */
    startTyping(chatId) {
        if (this.typingTimers.has(chatId))
            return;
        const fire = () => {
            this.client.call('set_input_status', { user_id: String(chatId), event_type: 1 }).catch(() => { });
        };
        fire();
        this.typingTimers.set(chatId, setInterval(fire, 5000));
        this.typingCaps.set(chatId, setTimeout(() => this.stopTyping(chatId), 10 * 60 * 1000));
    }
    stopTyping(chatId) {
        const timer = this.typingTimers.get(chatId);
        if (timer !== undefined) {
            clearInterval(timer);
            this.typingTimers.delete(chatId);
        }
        const cap = this.typingCaps.get(chatId);
        if (cap !== undefined) {
            clearTimeout(cap);
            this.typingCaps.delete(chatId);
        }
    }
    sendSegments(params) {
        const segments = segmentReply(params.text, this.config);
        let skipped = 0;
        // 2026-09-29 人味语速：私聊首条前触发"正在输入"，打字时长=基础+字数×系数（真人节奏）
        if (!params.isGroup) {
            const totalLen = params.text.length;
            this.enqueue(async () => {
                try {
                    await this.client.call('set_input_status', { user_id: String(params.chatId), event_type: 1 });
                }
                catch { /* 部分客户端不支持 */ }
                await new Promise((r) => setTimeout(r, Math.min(900 + totalLen * 45, 6000)));
            });
        }
        let firstInBatch = true;
        for (const piece of segments) {
            // Cross-reply dedup: the same sentence never goes out twice.
            const key = piece.trim().toLowerCase();
            if (this.sentHistory.has(key)) {
                skipped += 1;
                continue;
            }
            this.sentHistory.add(key);
            // Hard-split any segment still over the per-message cap.
            for (const chunk of smartSplitMessage(piece, this.config.maxMessageLength)) {
                const message = [];
                if (params.replyTo !== null && firstInBatch)
                    message.push({ type: 'reply', data: { id: String(params.replyTo) } });
                message.push({ type: 'text', data: { text: chunk } });
                firstInBatch = false;
                const action = params.isGroup ? 'send_group_msg' : 'send_private_msg';
                const payload = params.isGroup
                    ? { group_id: params.chatId, message }
                    : { user_id: params.chatId, message };
                this.enqueue(() => this.client.call(action, payload), () => `目标=${params.chatId} 分段全文: ${chunk}`, () => ({ action, payload }));
            }
        }
        // 发送完成后停掉"正在输入"循环（主人要看着bot打字：回合开始刷起，发出即停）
        if (!params.isGroup)
            this.enqueue(async () => { this.stopTyping(params.chatId); });
        if (skipped > 0)
            this.log(`skipped ${skipped} duplicate segment(s)`);
    }
    async sendNow(action, payload) {
        return this.client.call(action, payload);
    }
    /** Rate-limited send that resolves with the OneBot result when its turn in the chain comes. */
    push(task) {
        return new Promise((resolve, reject) => {
            this.chain = this.chain
                .then(() => new Promise((resolve) => setTimeout(resolve, this.config.rateLimitMs)))
                .then(() => task())
                .then((value) => resolve(value))
                .catch((error) => reject(error));
        });
    }
}
