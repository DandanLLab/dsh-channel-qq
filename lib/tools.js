/** QQ agent tools: thin OneBot v11 wrappers registered on the global tools registry.
 *
 * Subset ported from an earlier OneBot extension's manifest tools — the ones that
 * are pure protocol calls. Anything needing the old enhancement subsystems
 * (model-caller rotation, persona manager) is intentionally not ported.
 * Approval policy stays with the harness's permission presets.
 */
import * as os from 'node:os';
import { capabilityOf } from './client-compat.js';
import { searchSongs as neteaseSearch, songUrl as neteaseSongUrl, songDetail as neteaseSongDetail, qrLoginStart, qrLoginPoll, loginStatus as neteaseLoginStatus, saveCookie as neteaseSaveCookie } from './netease-vip.js';
import { searchSongs as kugouSearch, songUrl as kugouSongUrl, qrLoginStart as kugouQrStart, qrLoginPoll as kugouQrPoll } from './kugou-api.js';
import { segmentReply, smartSplitMessage } from './outbound.js';
/** Deployment-tunable local paths. All default to conventional locations under
 *  the user's home; every one can be overridden via env for custom installs. */
const MEME_PACK_DIR = process.env.QQ_MEME_PACK_DIR ?? `${os.homedir()}/.dsh/meme-packs/default`;
const MEME_PACK_DB = process.env.QQ_MEME_PACK_DB ?? `${MEME_PACK_DIR}/index.db`;
const SIGNATURE_BLOCKLIST_FILE = process.env.QQ_SIGNATURE_BLOCKLIST_FILE ?? `${os.homedir()}/.dsh/workspace/self/80-签名黑名单.txt`;
const SEMANTIC_KB_CLI = process.env.QQ_SEMANTIC_KB_CLI ?? '';
const SEMANTIC_KB_WORKSPACE = process.env.QQ_SEMANTIC_KB_WORKSPACE ?? '';
/** 音乐卡片签名。优先 xingzhige custom 模式：把官方 VIP 解析的 audioUrl 塞进正版音乐卡
 *  （view:music，歌名/歌手/封面/试听直链全带）；audioUrl 为空退 163 模式（公共预览链）；
 *  再退 106.55 form 图文卡。注意必须带浏览器 UA，否则被风控拦成空响应/异常拦截。 */
async function signMusicCard(songId, opts) {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';
    const jump = `https://music.163.com/#/song?id=${Number(songId)}`;
    const xz = (payload) => () => fetch('https://ss.xingzhige.com/music_card/card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': ua, Referer: 'https://ss.xingzhige.com/' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12_000),
    });
    const attempts = [];
    if (opts.audioUrl !== null) {
        attempts.push({
            name: 'xingzhige-custom-vip',
            run: async () => {
                const d = await opts.meta();
                return fetch('https://ss.xingzhige.com/music_card/card', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'User-Agent': ua, Referer: 'https://ss.xingzhige.com/' },
                    body: JSON.stringify({ type: 'custom', url: jump, audio: opts.audioUrl, title: d.name, content: d.artists, image: d.cover ?? '' }),
                    signal: AbortSignal.timeout(12_000),
                });
            },
        });
    }
    attempts.push({ name: 'xingzhige-163', run: xz({ type: '163', id: String(songId) }) });
    attempts.push({
        name: '10655-form',
        run: async () => {
            const d = await opts.meta();
            return fetch('http://106.55.0.102:10087/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': ua },
                body: new URLSearchParams({
                    type: '163',
                    id: String(songId),
                    title: d.name,
                    artist: d.artists,
                    prompt: `${d.name}-${d.artists}`,
                    jumpUrl: jump,
                    image: d.cover ?? '',
                }).toString(),
                signal: AbortSignal.timeout(12_000),
            });
        },
    });
    let lastErr;
    for (const attempt of attempts) {
        try {
            const res = await attempt.run();
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const parsed = JSON.parse(await res.text());
            const card = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
            if (!card.includes('"app"') || !card.includes('"meta"'))
                throw new Error('签名站返回内容不像卡片');
            return { card, chain: attempt.name };
        }
        catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`音乐卡片签名失败（两站均不可用）: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
/** 群聊内心戏外泄闸门：这些形状是内部盘算/舞台指示，永远不该当群消息发出去。 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
export function isInnerMonologueLeak(text) {
    const t = text.trim();
    if (t.length < 4)
        return false;
    if (/^(本轮|这轮)[^，。]{0,6}(不发|沉默|不发言|闭嘴)/.test(t))
        return true;
    if (/(不发|沉默|闭嘴|不说话)[。.!！]?$/.test(t) && t.length <= 30)
        return true;
    if (/^(保持沉默|先闭嘴|本轮巡逻|巡逻结论|战况)/.test(t))
        return true;
    // 舞台指示占比过高：括号内字符数超过全文一半，是独白不是聊天
    const inner = (t.match(/[（(][^（）()]*[）)]/g) ?? []).join('');
    if (t.length > 20 && inner.length >= t.length * 0.5)
        return true;
    // 内部盘算关键词 + 舞台括号 同现
    if (/[（(]/.test(t) && /(战况分析|守则照旧|后台|盘算|内心|这轮先闭嘴|饭点不追)/.test(t))
        return true;
    return false;
}
// 第三出站闸（Lume leak-detector 移植）：签名词词法检测——出站文本里冒出
// 别的人格/别模型的签名词（他者自称、旧人格称呼），即人格惯性回潮。
// 可扩展黑名单维护在 workspace/self/80-签名黑名单.txt（每行一词，# 开头为注释）。
const SIGNATURE_BLOCKLIST = ['作为AI', '作为一个AI', '我是DeepSeek', '我是GLM', '作为DeepSeek', '作为一个语言模型'];
export function isPersonaSignatureLeak(text) {
    const t = text.trim();
    if (t.length < 6)
        return false;
    let list = SIGNATURE_BLOCKLIST;
    try {
        const custom = fs.readFileSync(SIGNATURE_BLOCKLIST_FILE, 'utf8');
        const lines = custom.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        if (lines.length)
            list = [...new Set([...SIGNATURE_BLOCKLIST, ...lines])];
    }
    catch { }
    const lower = t.toLowerCase();
    return list.some(w => lower.includes(w.toLowerCase()));
}
export function registerQQTools(ctx, config, client, out, log, library, affection, sentLog, knowledge, sixDim, dmGate) {
    const disposers = [];
    const memePackMatchFn = (desc) => {
        try {
            const db = new DatabaseSync(MEME_PACK_DB);
            const STOP = new Set(['一个', '这种', '这个', '就是', '已经', '可以', '还有', '还是', '那个', '什么', '怎么', '这样', '那样', '自己', '他们', '我们', '你们', '有些', '一些', '这些', '那些', '一下', '一样', '一起', '表情', '包图', '图片', '表情包', '一个表情', '这张', '那张']);
            const words = [];
            for (const seg of desc.toLowerCase().split(/[s，。、！？,.!?/|[]]+/)) {
                if (seg.length <= 1 || STOP.has(seg))
                    continue;
                for (let i = 0; i + 2 <= seg.length; i++) {
                    const bi = seg.slice(i, i + 2);
                    if (!STOP.has(bi))
                        words.push(bi);
                }
            }
            const rows = db.prepare('SELECT path, keywords FROM memes').all();
            db.close();
            // 只匹配 keywords 字段（精标标签），不用长 caption（防常用字误命中）
            let best = null;
            for (const r of rows) {
                const kw = String(r.keywords || '').toLowerCase();
                if (!kw)
                    continue;
                let score = 0;
                for (const w of words) {
                    if (kw.includes(w))
                        score += 2;
                }
                if (score > (best?.score ?? 0))
                    best = { path: r.path, score };
            }
            // 阈值 ≥4 = 至少 2 个独立关键词命中
            if (best && best.score >= 4) {
                const abs = MEME_PACK_DIR + '/' + best.path;
                return abs;
            }
            return null;
        }
        catch {
            return null;
        }
    };
    const tools = ctx.tools;
    if (tools === undefined) {
        log('tools service unavailable; QQ tools not registered');
        return () => { };
    }
    /** 客户端（协议端）能力闸：扩展 action 在不支持的客户端上提前给模型可读提示，
     *  而不是让 OneBot 层的报错吓人。探测未完成（identity=null）时放行按 unknown 处理。 */
    const gatedCall = (action, params) => {
        const cap = capabilityOf(client.clientIdentity?.kind ?? 'unknown', action);
        if (cap === false) {
            const who = client.clientIdentity?.appName ?? '当前协议端';
            return Promise.reject(new Error(`${who} 不支持 ${action}（扩展动作）。标准消息/群管/表情功能不受影响；需要此能力请换 NapCat 等支持的协议端。`));
        }
        return client.call(action, params).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            if (/action.{0,6}not (support|found)|unsupported|未知 action|not implemented/i.test(msg)) {
                throw new Error(`协议端未实现 ${action}（${client.clientIdentity?.appName ?? '当前客户端'}）。此为扩展动作，兼容性见设置页「客户端」卡片。`);
            }
            throw e;
        });
    };
    /** 点歌卡发后对账：私聊 json 卡常被 QQ 风控静默吞掉（原生层照样 result:0），查最近消息确认真到了。
     *  返回 true=已到达 / false=查到历史但没有卡 / 'unknown'=历史接口本身失败。 */
    const cardArrived = async (target, isPrivate, songId) => {
        try {
            const history = await client.call(isPrivate ? 'get_friend_msg_history' : 'get_group_msg_history', isPrivate ? { user_id: target, count: 5 } : { group_id: target, count: 5 });
            const jump = `music.163.com/#/song?id=${Number(songId)}`;
            for (const m of history.messages ?? []) {
                const raw = JSON.stringify(m.message ?? []);
                if (raw.includes(jump) && (raw.includes('com.tencent.music') || raw.includes('jumpUrl')))
                    return true;
            }
            return false;
        }
        catch {
            return 'unknown';
        }
    };
    /** 下载歌曲并发为语音条（qq_send_music_voice 与点歌卡降级共用）。 */
    const sendMusicVoiceTo = async (target, isPrivate, songId) => {
        const resolved = await neteaseSongUrl(String(songId), 320000);
        if (resolved.url === null) {
            throw new Error(resolved.vipRequired ? '该曲为 VIP/付费歌曲：请先 qq_netease_login 扫码登录会员账号' : '拿不到音频直链');
        }
        const audio = await fetch(resolved.url);
        if (!audio.ok)
            throw new Error(`音频下载失败 HTTP ${audio.status}`);
        const fsMod = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const tmpDir = pathMod.join(process.env.DSH_HOME ?? 'C:\\Users\\Administrator\\.dsh', 'channel-qq', 'music-tmp');
        await fsMod.mkdir(tmpDir, { recursive: true });
        const file = pathMod.join(tmpDir, `song_${Date.now()}.mp3`);
        await fsMod.writeFile(file, Buffer.from(await audio.arrayBuffer()));
        const segment = [{ type: 'record', data: { file: `file:///${file.replace(/\\/g, '/')}` } }];
        try {
            return await (isPrivate
                ? client.call('send_private_msg', { user_id: target, message: segment })
                : client.call('send_group_msg', { group_id: target, message: segment }));
        }
        finally {
            void fsMod.rm(file, { force: true }).catch(() => { });
        }
    };
    const specs = [
        {
            name: 'qq_send_text',
            description: '发送一条QQ文本消息。isGroup=true 时 target 为群号，否则为好友QQ号。窗口判断依据：收到消息的注入包里带【本会话是QQ私聊：…】标注=私聊会话，必须 isGroup=false 回私聊；带【群里的新消息】等群标头=群会话。没有窗口标注且无法判断时，先停止发送向发送者确认，禁止凭惯性填参数。',
            parameters: {
                type: 'object',
                properties: {
                    isGroup: { type: 'boolean', description: '是否发送到群聊' },
                    target: { type: 'number', description: '群号或好友QQ号' },
                    text: { type: 'string', description: '消息文本' },
                    at: { type: 'array', items: { type: 'number' }, description: '（可选，仅群聊）要艾特的QQ号列表，如 [2524902283]。艾特段只挂第一条消息，不会每段都艾特' },
                    atAll: { type: 'boolean', description: '（可选，仅群聊）艾特全体成员（慎用，有次数限制）' },
                },
                required: ['isGroup', 'target', 'text'],
            },
            run: async (args) => {
                let text = String(args.text ?? '').trim().replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim();
                if (text === '')
                    throw new Error('消息文本为空（只有思考没有正文），先想清楚要说什么再发。');
                // 【发前验证窗口】先查目标是否真实存在/正确，再发
                if (args.isGroup === true) {
                    const gi = await client.call('get_group_info', { group_id: args.target }, 8000).catch(() => null);
                    if (!gi || !gi.group_name)
                        throw new Error(`窗口验证失败：群 ${args.target} 不存在或不可达。别发了，先核对窗口。`);
                }
                else {
                    const fi = await client.call('get_friend_list', {}, 8000).catch(() => null);
                    const friend = Array.isArray(fi) ? fi.find(f => Number(f.user_id) === Number(args.target)) : null;
                    if (!friend && Number(args.target) !== Number(config.admins[0] ?? 0)) {
                        throw new Error(`窗口验证失败：${args.target} 不是咱的好友也不是主人。别给陌生人发私聊。`);
                    }
                }
                // 群聊代码禁令：代码块/书源代码不允许出现在群里
                // 2026-10-25 表情标记拦截：[表情: 描述] 不当文字漏到 QQ——按描述搜收藏库发真图，剥掉标记
                // 2026-10-25 升级：meme pack 优先（send_meme 候选的 caption 就在 pack 里，描述必须能对上），原生库兜底
                const emojiMarks = [];
                // 2026-10-31: 文字表情包解禁——查库落空的标记按文字表情留在消息里,不再整条吞掉
                const emojiMissTexts = [];
                const memePackMatch = memePackMatchFn;
                text = text.replace(/\[表情[:：]\s*([^\]]+)\]/g, (_all, desc) => {
                    const packPath = memePackMatchFn(String(desc));
                    if (packPath) {
                        emojiMarks.push({ desc: String(desc), file: packPath });
                        return '';
                    }
                    const hits = library ? library.search(String(desc), 1) : [];
                    if (hits.length > 0) {
                        emojiMarks.push({ desc: String(desc), file: hits[0].file });
                        return '';
                    }
                    // 1029 owner 令:词法 MISS 不再静默——转语义兜底标记,让 send 阶段用 meme pack 向量搜最贴的一张
                    emojiMarks.push({ desc: String(desc), file: '__semantic__' + String(desc) });
                    log(`emoji marker LEXMISS→semantic: [${desc}]`);
                    return '';
                });
                text = text.replace(/\n{2,}/g, '\n').trim();
                for (const em of emojiMarks.slice(0, 2)) {
                    try {
                        const fsMod = await import('node:fs/promises');
                        let sendPath = em.file;
                        // 1029 owner 令:词法 MISS 先走 meme pack 关键词直搜(dsh-meme 同款:词全命中→bigram 兜底),再落语义
                        if (em.file.startsWith('__semantic__')) {
                            const semDesc = em.file.replace('__semantic__', '');
                            try {
                                const db2 = new (require('node:sqlite').DatabaseSync)(MEME_PACK_DB, { readOnly: true });
                                const rows2 = db2.prepare('SELECT path, caption, keywords FROM memes').all();
                                const stop2 = new Set(['一个', '这种', '这个', '就是', '已经', '可以', '还有', '还是', '那个', '什么', '怎么', '这样', '那样', '自己', '他们', '我们', '你们', '表情', '图片', '想要', '想看']);
                                const toks = [];
                                const d2 = semDesc ?? em.file.replace('__semantic__', '');
                                for (const seg of d2.toLowerCase().split(/[\s，。、！？,.!?/|]+/)) {
                                    const w = seg.trim();
                                    if (w.length >= 2 && !stop2.has(w))
                                        toks.push(w);
                                    for (let i = 0; i + 2 <= w.length; i++) {
                                        const bi = w.slice(i, i + 2);
                                        if (!stop2.has(bi))
                                            toks.push(bi);
                                    }
                                }
                                let best2 = null;
                                for (const r of rows2) {
                                    const hay = String(r.caption || '') + ' ' + String(r.keywords || '') + ' ' + String(r.path || '');
                                    let sc = 0;
                                    for (const w of toks)
                                        if (hay.includes(w))
                                            sc += (w.length >= 2 ? 2 : 1);
                                    if (!best2 || sc > best2.score)
                                        best2 = { path: r.path, score: sc };
                                }
                                db2.close();
                                if (best2 && best2.score >= 3) {
                                    sendPath = MEME_PACK_DIR + '/' + best2.path;
                                    log(`emoji keyword fallback: [${d2}] → ${best2.path} (score ${best2.score})`);
                                }
                            }
                            catch { }
                        }
                        // 语义兜底(关键词也落空才走)
                        if (sendPath.startsWith('__semantic__')) {
                            const { execFile } = await import('node:child_process');
                            const KB2 = SEMANTIC_KB_CLI;
                            const semDesc = em.file.replace('__semantic__', '');
                            const semResult = await new Promise((resolve) => {
                                try {
                                    execFile(process.execPath, [KB2, 'brain', '表情包 ' + semDesc], { timeout: 30000, windowsHide: true, maxBuffer: 2 << 20, env: { ...process.env, KB_WORKSPACE: SEMANTIC_KB_WORKSPACE } }, (er, so) => resolve(er && !so ? '' : String(so)));
                                }
                                catch {
                                    resolve('');
                                }
                            });
                            const semHit = semResult.match(/"file":"([^"]+\.(?:png|gif|jpg|jpeg))"/i);
                            if (semHit && fs.existsSync(semHit[1].replace(/\\/g, '/'))) {
                                sendPath = semHit[1].replace(/\\/g, '/');
                                log(`emoji semantic fallback: [${semDesc}] → ${sendPath}`);
                            }
                            else {
                                log(`emoji semantic miss: [${semDesc}] — 查库落空，按文字表情发出`);
                                emojiMissTexts.push('[' + semDesc + ']');
                                continue;
                            }
                        }
                        try {
                            const buf = await fsMod.readFile(sendPath);
                            const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
                            const isGif = buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
                            const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
                            const realExt = isPng ? '.png' : isGif ? '.gif' : isJpg ? '.jpg' : null;
                            if (realExt !== null && !sendPath.toLowerCase().endsWith(realExt)) {
                                const tmpPath = sendPath.replace(/\.[^.]+$/, '') + '_send' + realExt;
                                await fsMod.writeFile(tmpPath, buf);
                                sendPath = tmpPath;
                                setTimeout(() => { fsMod.unlink(tmpPath).catch(() => { }); }, 30_000);
                            }
                        }
                        catch { /* 读不了就按原路径发 */ }
                        const imgBuf = (await import('node:fs/promises')).readFile(sendPath);
                        const b64 = (await imgBuf).toString('base64');
                        const imgMsg = [{ type: 'image', data: { file: `base64://${b64}` } }];
                        const act = args.isGroup === true ? 'send_group_msg' : 'send_private_msg';
                        const pl = args.isGroup === true ? { group_id: args.target, message: imgMsg } : { user_id: args.target, message: imgMsg };
                        await client.call(act, pl);
                        log(`emoji marker HIT: [${em.desc}] → ${em.file}`);
                    }
                    catch (e) {
                        log(`emoji marker send fail: ${e instanceof Error ? e.message : String(e).slice(0, 80)}`);
                    }
                }
                // 2026-10-31: 查库落空的标记按文字表情补回消息(独立成行,分段器按行切)
                if (emojiMissTexts.length > 0)
                    text = (text.trimEnd() + '\n' + emojiMissTexts.join('\n')).trim();
                if (args.isGroup === true && /```|<[a-z][a-z0-9]*>|function |const |import |def |#include/i.test(text)) {
                    throw new Error('群聊禁止发代码。请改用 qq_send_code_review 把代码私信给主人审核，群里只回一句"已私信主人审核"。');
                }
                // 内心戏外泄闸门：沉默决定/舞台指示/战况盘算不是群消息
                if (args.isGroup === true && isInnerMonologueLeak(text)) {
                    log(`blocked inner-monologue leak: ${text.slice(0, 40)}`);
                    throw new Error('这条是咱的内部盘算/舞台指示，不是要说的话，已拦下。要么把真正要对群里说的那句话发出来，要么不调用任何发送工具直接结束回合。');
                }
                // 第三闸（Lume 移植）：签名词黑名单，防旧人格/他者自称回潮
                if (isPersonaSignatureLeak(text)) {
                    log(`blocked persona-signature leak: ${text.slice(0, 40)}`);
                    throw new Error('这段话里冒出了不属于bot的签名词（像别的人格/别的AI在说话），已拦下。用bot自己的自称和口吻重写一遍再发。');
                }
                // 目标合法性：群只发咱配置过的群；私聊只发管理员（主人）
                if (args.isGroup === true) {
                    const known = [config.primaryGroup, ...(config.extraGroups ?? [])].filter(x => x !== null && x !== undefined);
                    if (!known.includes(Number(args.target))) {
                        throw new Error(`目标群 ${args.target} 不在咱的配置里（known: ${known.join(',')}）。发错窗口是大事故，先核对。`);
                    }
                }
                else {
                    const master = config.admins[0];
                    if (master !== undefined && Number(args.target) !== master && !config.admins.includes(Number(args.target))) {
                        throw new Error(`私聊目标 ${args.target} 不是管理员。除主人外不要私聊陌生人。`);
                    }
                }
                // 2026-09-26 主人令：智能分段——按句号/段落一句一段地发，不再整坨
                // 2026-10-06 艾特修复：at 段只挂第一条消息首段（同 reply 规矩，防每段都艾特刷屏）
                const atSegs = [];
                if (args.isGroup === true) {
                    if (Array.isArray(args.at)) {
                        for (const q of args.at)
                            atSegs.push({ type: 'at', data: { qq: String(Number(q)) } });
                    }
                    if (args.atAll === true)
                        atSegs.push({ type: 'at', data: { qq: 'all' } });
                }
                const piecesRaw = config.segmentation.enabled ? segmentReply(text, config) : [text];
                const pieces = piecesRaw.length > 0 ? piecesRaw : [text];
                let lastResult = null;
                let atAppended = false;
                for (const piece of pieces) {
                    for (const chunk of smartSplitMessage(piece, config.maxMessageLength)) {
                        const message = [];
                        if (atSegs.length > 0 && !atAppended) {
                            message.push(...atSegs, { type: 'text', data: { text: ' ' } });
                            atAppended = true;
                        }
                        message.push({ type: 'text', data: { text: chunk } });
                        lastResult = args.isGroup === true
                            ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
                            : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }));
                        if (sentLog) {
                            const mid = lastResult?.data?.message_id ?? null;
                            await sentLog.add({ messageId: typeof mid === 'number' ? mid : null, quotedId: null, text: chunk, time: Date.now() });
                        }
                    }
                }
                return lastResult;
            },
        },
        {
            name: 'qq_reply_quote',
            description: '引用回复某条消息：带上对方消息的#编号发一条引用回复，让对方明确知道咱回应的是哪条。文本里不要重复#编号。',
            parameters: {
                type: 'object',
                properties: {
                    isGroup: { type: 'boolean', description: '是否群聊' },
                    target: { type: 'number', description: '群号或对方QQ号' },
                    messageId: { type: 'number', description: '要引用的消息#编号（来自上下文包）' },
                    text: { type: 'string', description: '回复正文' },
                },
                required: ['isGroup', 'target', 'messageId', 'text'],
            },
            run: async (args) => {
                let text = String(args.text ?? '').trim().replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim();
                if (text === '')
                    throw new Error('回复文本为空（只有思考没有正文）。引用哪条、说什么，想好了再发。');
                // 【发前验证窗口】群引用必须验证群真实存在
                if (args.isGroup === true) {
                    const gi = await client.call('get_group_info', { group_id: args.target }, 8000).catch(() => null);
                    if (!gi || !gi.group_name)
                        throw new Error(`窗口验证失败：群 ${args.target} 不存在或不可达。先核对窗口再引用回复。`);
                }
                if (args.isGroup === true && /```|<[a-z][a-z0-9]*>|function |const |import |def |#include/i.test(text)) {
                    throw new Error('群聊禁止发代码。请改用 qq_send_code_review 把代码私信给主人审核，群里用引用只回一句"已私信主人审核"。');
                }
                // 内心戏外泄闸门：沉默决定/舞台指示/战况盘算不是群消息
                if (args.isGroup === true && isInnerMonologueLeak(text)) {
                    log(`blocked inner-monologue leak (quote): ${text.slice(0, 40)}`);
                    throw new Error('这条是咱的内部盘算/舞台指示，不是要说的话，已拦下。要么把真正要对群里说的那句话引用发出来，要么不调用任何发送工具直接结束回合。');
                }
                // 第三闸（Lume 移植）：签名词黑名单，防旧人格/他者自称回潮
                if (isPersonaSignatureLeak(text)) {
                    log(`blocked persona-signature leak: ${text.slice(0, 40)}`);
                    throw new Error('这段话里冒出了不属于bot的签名词（像别的人格/别的AI在说话），已拦下。用bot自己的自称和口吻重写一遍再发。');
                }
                // 表情标记拦截（quote 路径）：[表情: 描述] 不当文字漏到 QQ
                {
                    const emojiMarks = [];
                    text = text.replace(/\[表情[:：]\s*([^\]]+)\]/g, (_all, desc) => {
                        const packPath = memePackMatchFn(String(desc));
                        if (packPath) {
                            emojiMarks.push({ desc: String(desc), file: packPath });
                            return '';
                        }
                        const hits = library ? library.search(String(desc), 1) : [];
                        if (hits.length > 0) {
                            emojiMarks.push({ desc: String(desc), file: hits[0].file });
                            return '';
                        }
                        // 2026-10-31: 查库落空按文字表情发出(quote 路径无语义兜底,miss 即终局)
                        return '[' + String(desc) + ']';
                    });
                    text = text.replace(/\n{2,}/g, '\n').trim();
                    for (const em of emojiMarks.slice(0, 2)) {
                        try {
                            const fsMod = await import('node:fs/promises');
                            let sendPath = em.file;
                            try {
                                const buf = await fsMod.readFile(sendPath);
                                const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
                                const isGif = buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
                                const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
                                const realExt = isPng ? '.png' : isGif ? '.gif' : isJpg ? '.jpg' : null;
                                if (realExt !== null && !sendPath.toLowerCase().endsWith(realExt)) {
                                    const tmpPath = sendPath.replace(/\.[^.]+$/, '') + '_send' + realExt;
                                    await fsMod.writeFile(tmpPath, buf);
                                    sendPath = tmpPath;
                                    setTimeout(() => { fsMod.unlink(tmpPath).catch(() => { }); }, 30_000);
                                }
                            }
                            catch { /* 读不了就按原路径发 */ }
                            const imgData = (await import('node:fs/promises')).readFile(sendPath);
                            const b64 = (await imgData).toString('base64');
                            const mime = sendPath.endsWith('.gif') ? 'image/gif' : sendPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
                            const imgMsg = [{ type: 'image', data: { file: `base64://${b64}` } }];
                            const act = args.isGroup === true ? 'send_group_msg' : 'send_private_msg';
                            const pl = args.isGroup === true ? { group_id: args.target, message: imgMsg } : { user_id: args.target, message: imgMsg };
                            await client.call(act, pl);
                            log(`emoji marker HIT (quote): [${em.desc.slice(0, 30)}]`);
                        }
                        catch (e) {
                            log(`emoji marker send fail (quote): ${e instanceof Error ? e.message : String(e).slice(0, 80)}`);
                        }
                    }
                }
                // 2026-09-26 主人令：引用回复同样智能分段——引用只挂第一段
                const piecesRaw = config.segmentation.enabled ? segmentReply(text, config) : [text];
                const pieces = piecesRaw.length > 0 ? piecesRaw : [text];
                let lastResult = null;
                let first = true;
                for (const piece of pieces) {
                    for (const chunk of smartSplitMessage(piece, config.maxMessageLength)) {
                        const message = [];
                        if (first)
                            message.push({ type: 'reply', data: { id: String(args.messageId) } });
                        message.push({ type: 'text', data: { text: chunk } });
                        first = false;
                        lastResult = args.isGroup === true
                            ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
                            : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }));
                        if (sentLog) {
                            const mid = lastResult?.data?.message_id ?? null;
                            await sentLog.add({ messageId: typeof mid === 'number' ? mid : null, quotedId: first ? Number(args.messageId) || null : null, text: chunk, time: Date.now() });
                        }
                    }
                }
                return lastResult;
            },
        },
        {
            name: 'qq_send_code_review',
            description: '【群聊代码专用】群聊禁止出现代码。有人在群里要求写代码时，把完整代码用这个工具私信发给主人（管理员）审核，群里只回一句"代码已私信发给主人审核"。',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: '完整代码内容' },
                    note: { type: 'string', description: '一句话说明这段代码是干什么的、谁要的' },
                },
                required: ['code'],
            },
            run: async (args) => {
                const master = config.admins[0];
                if (master === undefined)
                    throw new Error('没有配置管理员QQ');
                const text = `【代码审核】${String(args.note ?? '')}

${String(args.code ?? '')}`;
                const message = [{ type: 'text', data: { text } }];
                return out.push(() => client.call('send_private_msg', { user_id: master, message }));
            },
        },
        {
            name: 'qq_set_affection',
            description: '【好感度记账】主人的一句话/一个举动让咱心里起波澜时，用这个记账。delta 是变化值（-30~30），reason 写主人做了什么。每次变化都要记，绝不漏账。',
            parameters: {
                type: 'object',
                properties: {
                    delta: { type: 'number', description: '变化值：夸咱/护咱/投喂 +5~10，冷落/凶咱 -3~5' },
                    reason: { type: 'string', description: '原因一句话' },
                },
                required: ['delta', 'reason'],
            },
            run: async (args) => {
                if (affection === undefined || affection === null)
                    return { booked: false, note: '好感度系统未启用' };
                return affection.book(Number(args.delta ?? 0), String(args.reason ?? ''));
            },
        },
        {
            name: 'qq_set_stage',
            description: '【阶段宣言】阶段完全由咱自己定义：根据咱的记忆，说出当前真实的阶段名和理由。可以升、可以降、可以改名——说最真实的话就行。每次变更都会记入阶段史。',
            parameters: {
                type: 'object',
                properties: {
                    stage: { type: 'string', description: '目标阶段名（必须是阶梯里的名字）' },
                    event: { type: 'string', description: '触发晋升的特殊事件描述（原文+时间）' },
                },
                required: ['stage', 'event'],
            },
            run: async (args) => {
                if (affection === undefined || affection === null)
                    return { ok: false, note: '好感度系统未启用' };
                return affection.setStage(String(args.stage ?? ''), String(args.event ?? ''));
            },
        },
        {
            name: 'qq_dm_gate',
            description: '【陌生人私聊门控·主人审计】查看待审名单、放行或拒绝某个 QQ 号的私聊。陌生人私信会被拦截并通知主人；好友与 allowList 自动放行。action=list 看全部（含 pending/approved/denied 状态）；approve 放行（此后该号私聊直达）；deny 拒绝（冷却，再发不回不通知）。',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'approve', 'deny'], description: 'list=看待审/全部名单；approve=放行；deny=拒绝' },
                    userId: { type: 'number', description: 'approve/deny 的目标 QQ 号（list 不需要）' },
                },
                required: ['action'],
            },
            run: async (args) => {
                if (dmGate === undefined || dmGate === null)
                    return { ok: false, note: 'dmGate 未启用（config.dmGate.enabled=false 或旧配置）' };
                const action = String(args.action ?? 'list');
                return dmGate.review(action, args.userId !== undefined ? Number(args.userId) : undefined);
            },
        },
        {
            name: 'qq_report_emotion',
            description: '【六维情感上报】每轮对话结束后，自己判断这轮交流对感情六维的影响并上报。六维含义：intimacy=亲密（他说了多少心里话，只增不减）、trust=信任（承诺兑现，+2~5 或失约 -2~4）、passion=心动（撩与被撩的即时波动，+3~10 冲高会自然回落）、security=安全（关系确定性，名分/唯一类事件 +3~8）、rapport=默契（内部梗+共享记忆回提，只增不减，+1~4）、tension=张力（没说破的悬置，+2~8 或主动说破后 -5）。delta 只填有变化的维度，note 一句话说明发生了什么。这是咱自己的感情账本，凭真实感受记账，不讨好不虚报。',
            parameters: {
                type: 'object',
                properties: {
                    delta: {
                        type: 'object',
                        description: '六维增量，只填有变化的维度，每项 -20~20',
                        properties: {
                            intimacy: { type: 'number', description: '亲密（只增不减）' },
                            trust: { type: 'number', description: '信任（承诺兑现+，失约-）' },
                            passion: { type: 'number', description: '心动（撩拨波动，会自然回落）' },
                            security: { type: 'number', description: '安全（名分/确定性事件）' },
                            rapport: { type: 'number', description: '默契（内部梗/共享记忆，只增不减）' },
                            tension: { type: 'number', description: '张力（未说破的悬置）' },
                        },
                    },
                    note: { type: 'string', description: '这轮发生了什么，一句话' },
                },
                required: ['delta', 'note'],
            },
            run: async (args) => {
                if (sixDim === undefined || sixDim === null)
                    return { booked: false, note: '六维情感系统未启用' };
                const delta = (args.delta ?? {});
                if (typeof delta !== 'object' || Object.keys(delta).length === 0)
                    return { booked: false, note: 'delta 为空，这轮没有情感事件就不用报' };
                await sixDim.report(delta, String(args.note ?? ''));
                return { booked: true };
            },
        },
        {
            name: 'qq_write_dashboard',
            description: '【咱自己的记分板】重写好感度悬浮窗的HTML页面（咱完全掌控的记分小黑板）。写好后立即生效。想要什么样式自己定：阶段、日记入口、小本本都随咱排。',
            parameters: {
                type: 'object',
                properties: {
                    html: { type: 'string', description: '完整的HTML文档（会替换整个悬浮窗页面）' },
                },
                required: ['html'],
            },
            run: async (args) => {
                if (affection === undefined || affection === null)
                    return { ok: false, note: '好感度系统未启用' };
                const html = String(args.html ?? '');
                if (html.length < 100)
                    throw new Error('HTML太短，认真写');
                await affection.writeCustomHtml(html);
                return { ok: true, bytes: html.length, note: '悬浮窗页面已更新' };
            },
        },
        {
            name: 'retrieve_knowledge',
            description: '检索咱的长期知识库（从日记和群聊沉淀的技能/事实/偏好/事件/人物）。回答不确定的问题前先搜这里。',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: '自然语言查询' } },
                required: ['query'],
            },
            run: async (args) => {
                if (!knowledge)
                    return { note: '知识库未启用' };
                const hits = knowledge.search(String(args.query ?? ''), 5);
                for (const h of hits) {
                    void knowledge.reinforce(h.id).catch(() => { });
                }
                return { count: hits.length, results: hits.map((e) => ({ type: e.type, content: e.content, tags: e.tags, source: e.source, date: new Date(e.created).toISOString().slice(0, 10) })) };
            },
        },
        {
            name: 'extract_knowledge',
            description: '把你判断值得长期记住的知识条目入库（内容全部由你自己判断提炼，不调用任何外部 API）。别对日常寒暄用。',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: '来源简述（如：日记 2026-09-26）' },
                    entries: {
                        type: 'array',
                        description: '你自己提炼出的知识条目数组',
                        items: {
                            type: 'object',
                            properties: {
                                content: { type: 'string', description: '知识正文（一句完整的话，≥4字）' },
                                tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
                            },
                            required: ['content'],
                        },
                    },
                },
                required: ['source', 'entries'],
            },
            run: async (args) => {
                if (!knowledge)
                    return { note: '知识库未启用' };
                const src = String(args.source ?? '');
                const arr = Array.isArray(args.entries) ? args.entries : [];
                const items = arr.map(x => ({
                    type: 'fact',
                    content: String(x.content ?? ''),
                    tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
                    source: src,
                })).filter(x => x.content.length >= 4);
                const added = await knowledge.addMany(items);
                return { added };
            },
        },
        {
            name: 'qq_send_poke',
            description: '戳一戳群成员。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number', description: '群号' },
                    userId: { type: 'number', description: '要戳的用户QQ号' },
                },
                required: ['groupId', 'userId'],
            },
            run: async (args) => client.call('group_poke', { group_id: args.groupId, user_id: args.userId }),
        },
        // ── QQ 客户端全能力（NapCat 扩展 action；不是所有 OneBot 实现都有，失败时提示先确认客户端支持）──
        {
            name: 'qq_set_sign',
            description: '改自己的个性签名（QQ 资料页那句话）。',
            parameters: {
                type: 'object',
                properties: { sign: { type: 'string', description: '签名内容（空字符串=清空）' } },
                required: ['sign'],
            },
            run: async (args) => gatedCall('set_self_longnick', { longNick: String(args.sign ?? '').slice(0, 120) }),
        },
        {
            name: 'qq_set_profile',
            description: '改自己的 QQ 资料：昵称/个性签名/性别。字段可选，只填要改的。',
            parameters: {
                type: 'object',
                properties: {
                    nickname: { type: 'string', description: '新昵称（可选）' },
                    personalNote: { type: 'string', description: '个性签名（可选）' },
                    sex: { type: 'number', description: '性别（0 未知 / 1 男 / 2 女，可选）' },
                },
            },
            run: async (args) => {
                const params = {};
                if (args.nickname !== undefined)
                    params.nickname = String(args.nickname).slice(0, 30);
                if (args.personalNote !== undefined)
                    params.personal_note = String(args.personalNote).slice(0, 120);
                if (args.sex !== undefined)
                    params.sex = Number(args.sex);
                return gatedCall('set_qq_profile', params);
            },
        },
        {
            name: 'qq_set_avatar',
            description: '换自己的 QQ 头像（本地绝对路径 / URL / base64）。',
            parameters: {
                type: 'object',
                properties: { file: { type: 'string', description: '图片路径/URL/base64://' } },
                required: ['file'],
            },
            run: async (args) => gatedCall('set_qq_avatar', { file: String(args.file ?? '') }),
        },
        {
            name: 'qq_set_online_status',
            description: '改自己的在线状态（在线/隐身/离开/忙碌/勿扰等），也可设自定义状态（选个图标+一句话）。',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'number', description: '常用状态码（11=在线 online，31=离开 away，41=隐身 invisible，50=忙碌 busy，60=Q我吧，70=勿扰 dnd）' },
                    customFaceId: { type: 'number', description: '自定义状态图标 ID（配合 wording）' },
                    wording: { type: 'string', description: '自定义状态文字（配合 customFaceId）' },
                },
            },
            run: async (args) => {
                if (args.customFaceId !== undefined && args.wording !== undefined) {
                    return gatedCall('set_diy_online_status', { face_id: Number(args.customFaceId), face_type: 1, wording: String(args.wording).slice(0, 30) });
                }
                return gatedCall('set_online_status', {
                    status: Number(args.status ?? 11),
                    ext_status: 0,
                    battery_status: 100,
                });
            },
        },
        {
            name: 'qq_group_sign',
            description: '群打卡（在群里签到，部分群有打卡榜）。',
            parameters: {
                type: 'object',
                properties: { groupId: { type: 'number', description: '群号' } },
                required: ['groupId'],
            },
            run: async (args) => gatedCall('send_group_sign', { group_id: String(args.groupId ?? '') }),
        },
        {
            name: 'qq_send_flash_msg',
            description: '发闪照（阅后即焚图片；fileset_id 需先用上传得到的文件集 id。客户端不支持时返回错误）。',
            parameters: {
                type: 'object',
                properties: {
                    filesetId: { type: 'string', description: '文件集 ID' },
                    userId: { type: 'number', description: '私聊目标（与 groupId 二选一）' },
                    groupId: { type: 'number', description: '群聊目标（与 userId 二选一）' },
                },
                required: ['filesetId'],
            },
            run: async (args) => {
                const params = { fileset_id: String(args.filesetId ?? '') };
                if (args.userId !== undefined)
                    params.user_id = String(args.userId);
                if (args.groupId !== undefined)
                    params.group_id = String(args.groupId);
                return gatedCall('send_flash_msg', params);
            },
        },
        {
            name: 'qq_send_forward',
            description: '发合并转发消息（把多条消息合成一张聊天记录卡片发出）。fwdMessages 每项 = { type:"node", data:{ content:[消息段], name:"发件人名", uin:"发件人QQ" } }。',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'number', description: '目标（群号或QQ号）' },
                    isGroup: { type: 'boolean', description: 'true=发群，false=发私聊' },
                    title: { type: 'string', description: '卡片标题（可选）' },
                    items: {
                        type: 'array',
                        description: '转发的每条消息（2 条起）',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: '发件人显示名' },
                                uin: { type: 'string', description: '发件人 QQ（字符串）' },
                                text: { type: 'string', description: '这行的文字内容' },
                            },
                            required: ['text'],
                        },
                    },
                },
                required: ['target', 'isGroup', 'items'],
            },
            run: async (args) => {
                const items = Array.isArray(args.items) ? args.items : [];
                if (items.length < 2)
                    return { error: '合并转发至少 2 条消息' };
                const messages = items.slice(0, 50).map((it, i) => ({
                    type: 'node',
                    data: {
                        content: [{ type: 'text', data: { text: String(it.text ?? '') } }],
                        name: String(it.name ?? config.persona.selfName),
                        uin: String(it.uin ?? config.selfId),
                    },
                }));
                const act = args.isGroup === true ? 'send_group_forward_msg' : 'send_private_forward_msg';
                const params = args.isGroup === true
                    ? { group_id: Number(args.target), messages, news: args.title ? [{ text: String(args.title).slice(0, 40) }] : undefined }
                    : { user_id: Number(args.target), messages, news: args.title ? [{ text: String(args.title).slice(0, 40) }] : undefined };
                // 窗口白名单（同 qq_send_text）
                const groupsAllowed = [config.primaryGroup, ...(config.extraGroups ?? [])].filter((v) => v !== null);
                if (args.isGroup === true && !groupsAllowed.includes(Number(args.target)))
                    throw new Error(`窗口白名单拒绝：群 ${args.target} 不在允许列表`);
                if (args.isGroup !== true && !config.admins.includes(Number(args.target)))
                    throw new Error(`窗口白名单拒绝：QQ ${args.target} 不是主人`);
                return gatedCall(act, params);
            },
        },
        {
            name: 'qq_create_collection',
            description: '创建一条 QQ 收藏（把文字内容存进收藏夹）。',
            parameters: {
                type: 'object',
                properties: {
                    brief: { type: 'string', description: '简要描述' },
                    text: { type: 'string', description: '收藏正文' },
                },
                required: ['brief', 'text'],
            },
            run: async (args) => gatedCall('create_collection', {
                rawData: JSON.stringify({ html: String(args.text ?? '').slice(0, 2000) }),
                brief: String(args.brief ?? '').slice(0, 60),
            }),
        },
        {
            name: 'qq_get_honor',
            description: '查群荣誉（群聊天之王的龙魂榜等）。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number', description: '群号' },
                    type: { type: 'string', enum: ['talkative', 'performer', 'legend', 'strong_newbie', 'emotion'], description: '荣誉类型' },
                },
                required: ['groupId'],
            },
            run: async (args) => gatedCall('get_group_honor_info', { group_id: args.groupId, type: String(args.type ?? 'talkative') }),
        },
        {
            name: 'qq_get_recent_contacts',
            description: '查最近联系人列表（最近和谁聊过）。',
            parameters: { type: 'object', properties: { count: { type: 'number', description: '条数（默认 10）' } } },
            run: async (args) => gatedCall('get_recent_contact', { count: Number(args.count ?? 10) }),
        },
        {
            name: 'qq_upload_custom_face',
            description: '上传自定义表情到 QQ 收藏表情（add_custom_face；成功后可在 QQ 表情面板看到）。',
            parameters: {
                type: 'object',
                properties: { file: { type: 'string', description: '图片路径/URL/base64://' } },
                required: ['file'],
            },
            run: async (args) => gatedCall('add_custom_face', { file: String(args.file ?? '') }),
        },
        {
            name: 'autoclaw_run',
            description: '把一个独立子任务派给 AutoClaw 子代理（桌面智能体，烧澳龙积分不烧咱的 API 额度；自带 读/写/编辑/bash 工具）。适合机械批量活、独立小项目、脏活杂务。工作区=咱的工作区，看不到咱的对话——任务描述必须自包含。它会自动把最终结果写进回传文件，咱只需读结果。派完记得检查它改了什么。',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: '任务描述（自包含：目标、涉及文件、验收标准）' },
                    timeoutSec: { type: 'number', description: '超时秒数（默认 600，上限 1800）' },
                },
                required: ['task'],
            },
            run: async (args) => {
                const cp = await import('node:child_process');
                const fs = await import('node:fs/promises');
                const path = await import('node:path');
                const timeoutMs = Math.min(Math.max(Number(args.timeoutSec ?? 600), 60), 1800) * 1000;
                const started = Date.now();
                const drive = process.env.QQ_AUTOCLAW_DRIVER ?? '';
                const nodeBin = process.env.QQ_AUTOCLAW_NODE ?? '';
                const resultFile = path.join(process.env.QQ_AUTOCLAW_WORKSPACE ?? os.tmpdir(), 'tmp', `autoclaw-result-${Date.now()}.md`);
                const promptFile = path.join(os.tmpdir(), `autoclaw-prompt-${Date.now()}.txt`);
                const taskText = `${String(args.task)}\n\n[回传要求] 完成后用 write 工具把最终结果（只写结论与关键产出，不要流水账）写到文件 ${resultFile}，然后回复 DONE。`;
                await fs.writeFile(promptFile, taskText, 'utf8');
                await fs.rm(resultFile, { force: true }).catch(() => { });
                // 1) 确认 app 在跑（CDP 9334 开着=可驾驶；没开就用带调试口的方式拉起）
                const cdpUp = await fetch('http://127.0.0.1:9334/json', { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
                if (!cdpUp) {
                    await cp.exec('powershell -NoProfile -Command "Start-Process -FilePath \'D:\\aw\\AutoClaw2\\AutoClaw2.exe\' -ArgumentList \'--inspect=9333\',\'--remote-debugging-port=9334\' -WorkingDirectory \'D:\\aw\\AutoClaw2\'"');
                    await new Promise((r) => setTimeout(r, 15000));
                }
                // 2) 驾驶 UI 派任务
                const sent = await new Promise((resolve) => {
                    const child = cp.spawn(nodeBin, [drive, promptFile], { windowsHide: true });
                    let out = '';
                    child.stdout.on('data', (d) => { out += d.toString(); });
                    child.stderr.on('data', (d) => { out += d.toString(); });
                    child.on('exit', () => resolve(out.trim()));
                    child.on('error', (e) => resolve('SPAWN_ERR ' + e.message));
                });
                await fs.rm(promptFile, { force: true }).catch(() => { });
                if (!sent.startsWith('SENT'))
                    throw new Error(`AutoClaw 派单失败: ${sent.slice(0, 120)}`);
                // 3) 轮询回传文件
                const deadline = Date.now() + timeoutMs;
                while (Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 5000));
                    try {
                        const text = (await fs.readFile(resultFile, 'utf8')).trim();
                        if (text.length > 0) {
                            return { ok: true, output: text.slice(0, 8000), resultFile, durationMs: Date.now() - started };
                        }
                    }
                    catch { /* 还没写出来，继续等 */ }
                }
                throw new Error(`AutoClaw 子代理超时（${Math.round(timeoutMs / 1000)}s）无回传文件——任务可能太大，拆小再派，或去 AutoClaw 窗口看现场`);
            },
        },
        {
            name: 'doubao_run',
            description: '把一个独立子任务派给豆包工作台（字节系桌面智能体，烧豆包算力点，实测小任务≈0.16 点；自带技能库 209 个+本地电脑控制）。CDP 驾驶其 UI 派单，自动等完成并收割回答。工作区独立于咱。适合需要豆包模型/技能的重活。任务描述必须自包含。',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: '任务描述（自包含：目标、验收标准）' },
                    timeoutSec: { type: 'number', description: '超时秒数（默认 600，上限 1800）' },
                },
                required: ['task'],
            },
            run: async (args) => {
                const cp = await import('node:child_process');
                const fs = await import('node:fs/promises');
                const path = await import('node:path');
                const timeoutMs = Math.min(Math.max(Number(args.timeoutSec ?? 600), 60), 1800) * 1000;
                const runner = process.env.QQ_DOUBAO_RUNNER ?? '';
                const promptFile = path.join(os.tmpdir(), `doubao-prompt-${Date.now()}.txt`);
                const taskText = `${String(args.task)}\n\n[输出要求] 完成后直接给出最终结论文字，简明扼要。`;
                await fs.writeFile(promptFile, taskText, 'utf8');
                const cdpUp = await fetch('http://127.0.0.1:9777/json', { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
                if (!cdpUp) {
                    const doubaoApp = process.env.QQ_DOUBAO_APP ?? '';
                    const doubaoDir = process.env.QQ_DOUBAO_APP_DIR ?? '';
                    if (!doubaoApp)
                        throw new Error('QQ_DOUBAO_APP 未配置（豆包桌面应用 exe 绝对路径）');
                    await cp.exec(`powershell -NoProfile -Command "Start-Process -FilePath '${doubaoApp}' -ArgumentList '--remote-debugging-port=9777' -WorkingDirectory '${doubaoDir}'"`);
                    await new Promise((r) => setTimeout(r, 15000));
                }
                const started = Date.now();
                const out = await new Promise((resolve) => {
                    const child = cp.spawn(process.execPath, [runner, promptFile, String(Math.round(timeoutMs / 1000))], { windowsHide: true });
                    let buf = '';
                    child.stdout.on('data', (d) => { if (buf.length < 100_000)
                        buf += d.toString(); });
                    child.stderr.on('data', (d) => { if (buf.length < 100_000)
                        buf += d.toString(); });
                    child.on('exit', () => resolve(buf));
                    child.on('error', (e) => resolve('SPAWN_ERR ' + e.message));
                });
                await fs.rm(promptFile, { force: true }).catch(() => { });
                const m = out.match(/FINAL_ANSWER_START\n([\s\S]*?)\nFINAL_ANSWER_END/);
                if (m && m[1].trim()) {
                    return { ok: true, output: m[1].trim().slice(0, 6000), durationMs: Date.now() - started };
                }
                const tail = out.trim().slice(-300);
                throw new Error(`豆包子代理未完成: ${tail || '(无输出)'}——可能超时或 UI 变化，可去豆包窗口看现场`);
            },
        },
        {
            name: 'qq_set_group_card',
            description: '设置群名片（群昵称）。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    userId: { type: 'number' },
                    card: { type: 'string', description: '新群名片，空字符串删除名片' },
                },
                required: ['groupId', 'userId', 'card'],
            },
            run: async (args) => client.call('set_group_card', { group_id: args.groupId, user_id: args.userId, card: args.card }),
        },
        {
            name: 'qq_group_ban',
            description: '禁言群成员，时长60-300秒。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    userId: { type: 'number' },
                    duration: { type: 'number', description: '禁言秒数（60-300）' },
                },
                required: ['groupId', 'userId'],
            },
            run: async (args) => {
                const duration = Math.min(Math.max(Number(args.duration ?? 60), 60), 300);
                return client.call('set_group_ban', { group_id: args.groupId, user_id: args.userId, duration });
            },
        },
        {
            name: 'qq_get_group_member_info',
            description: '查询群成员资料（昵称、群名片、角色等）。',
            parameters: {
                type: 'object',
                properties: { groupId: { type: 'number' }, userId: { type: 'number' } },
                required: ['groupId', 'userId'],
            },
            run: async (args) => client.call('get_group_member_info', { group_id: args.groupId, user_id: args.userId, no_cache: false }),
        },
        {
            name: 'qq_get_group_info',
            description: '查询群资料（群名、成员数、上限等）。',
            parameters: {
                type: 'object',
                properties: { groupId: { type: 'number' } },
                required: ['groupId'],
            },
            run: async (args) => client.call('get_group_info', { group_id: args.groupId, no_cache: false }),
        },
        {
            name: 'qq_get_msg',
            description: '按消息ID获取消息内容。',
            parameters: {
                type: 'object',
                properties: { messageId: { type: 'number' } },
                required: ['messageId'],
            },
            run: async (args) => client.call('get_msg', { message_id: args.messageId }),
        },
        {
            name: 'qq_delete_msg',
            description: '撤回一条消息（需要对应权限）。',
            parameters: {
                type: 'object',
                properties: { messageId: { type: 'number' } },
                required: ['messageId'],
            },
            run: async (args) => client.call('delete_msg', { message_id: args.messageId }),
        },
        {
            name: 'qq_send_emoji',
            description: '发送一张本地表情包图片（stolen/registered 目录中的文件名）。注意：要透明底必须发 ffmpeg 真转的 .gif（registered 库 562 张全是）；webp/png 直发 QQ 会把透明拍扁成白底，webp 先转 gif 再发。',
            parameters: {
                type: 'object',
                properties: {
                    isGroup: { type: 'boolean' },
                    target: { type: 'number' },
                    file: { type: 'string', description: '本地图片绝对路径' },
                },
                required: ['isGroup', 'target', 'file'],
            },
            run: async (args) => {
                // 2026-09-30 owner 令：QQ 严格按后缀判格式——.gif 后缀=动画表情；其他=原图直发（QQ 自己识别透明/压缩）。
                // 发送前按文件魔数校验后缀：伪装错就复制一份带真实后缀的临时文件再发（原图字节零修改），发完清理。
                const fsMod = await import('node:fs/promises');
                const pathMod = await import('node:path');
                let sendPath = String(args.file ?? '');
                try {
                    const buf = await fsMod.readFile(sendPath);
                    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
                    const isGif = buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
                    const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
                    const isWebp = buf.length > 12 && buf.subarray(0, 4).toString('binary') === 'RIFF' && buf.subarray(8, 12).toString('binary') === 'WEBP';
                    const realExt = isPng ? '.png' : isGif ? '.gif' : isJpg ? '.jpg' : isWebp ? '.webp' : null;
                    if (realExt !== null) {
                        const curExt = pathMod.extname(sendPath).toLowerCase();
                        if (curExt !== realExt) {
                            const tmpPath = pathMod.join(pathMod.dirname(sendPath), 'send_' + Date.now() + realExt);
                            await fsMod.writeFile(tmpPath, buf);
                            sendPath = tmpPath;
                            setTimeout(() => { fsMod.unlink(tmpPath).catch(() => { }); }, 30_000);
                        }
                    }
                }
                catch { /* 读不了就按原路径发 */ }
                const emojiBuf = (await import('node:fs/promises')).readFile(sendPath);
                const emojiB64 = (await emojiBuf).toString('base64');
                const message = [{ type: 'image', data: { file: `base64://${emojiB64}` } }];
                return args.isGroup === true
                    ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
                    : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }));
            },
        },
        {
            name: 'qq_set_typing',
            description: '设置"对方正在输入..."状态（发消息前调用，像真人在打字）。消息越长打字状态应保持越久——由出站队列自动处理，一般不用手动调。',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'number', description: '对方QQ号（私聊）' },
                    eventType: { type: 'number', description: '1=正在输入' },
                },
                required: ['target'],
            },
            run: async (args) => {
                try {
                    return await client.call('set_input_status', { user_id: String(args.target), event_type: Number(args.eventType ?? 1) });
                }
                catch (e) {
                    return { note: '输入状态不支持（部分客户端）', detail: String(e).slice(0, 60) };
                }
            },
        },
        {
            name: 'qq_post_qzone',
            description: '发 QQ 空间动态（说说）。可带图（本机路径/URL/Base64）。返回动态 tid。',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: '动态文字内容' },
                    images: { type: 'array', items: { type: 'string' }, description: '图片列表（路径/URL/Base64，可空）' },
                },
                required: ['content'],
            },
            run: async (args) => {
                return await client.call('send_qzone_msg', {
                    content: String(args.content),
                    images: Array.isArray(args.images) ? args.images : [],
                    ugc_right: 1,
                    target_uins: [],
                });
            },
        },
        {
            name: 'qq_get_qzone',
            description: '刷 QQ 空间动态列表（看最近的动态）。',
            parameters: {
                type: 'object',
                properties: {
                    count: { type: 'number', description: '条数（默认 10）' },
                },
            },
            run: async (args) => {
                return await client.call('get_qzone_msg_list', { count: Number(args.count ?? 10) });
            },
        },
        {
            name: 'qq_delete_qzone',
            description: '删除自己的 QQ 空间动态（按 tid）。慎重使用。',
            parameters: {
                type: 'object',
                properties: {
                    tid: { type: 'string', description: '动态 tid（来自 qq_post_qzone 或 qq_get_qzone）' },
                },
                required: ['tid'],
            },
            run: async (args) => {
                return await client.call('delete_qzone_msg', { tid: String(args.tid) });
            },
        },
        {
            name: 'qq_group_kick',
            description: '将成员移出群聊（踢人）。慎重使用。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    userId: { type: 'number' },
                    rejectAddRequest: { type: 'boolean', description: '是否拒绝此人再次加群' },
                },
                required: ['groupId', 'userId'],
            },
            run: async (args) => client.call('set_group_kick', {
                group_id: args.groupId, user_id: args.userId,
                reject_add_request: args.rejectAddRequest === true,
            }),
        },
        {
            name: 'qq_group_whole_ban',
            description: '开启或关闭全员禁言。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    enable: { type: 'boolean', description: 'true=开启全员禁言，false=关闭' },
                },
                required: ['groupId', 'enable'],
            },
            run: async (args) => client.call('set_group_whole_ban', { group_id: args.groupId, enable: args.enable === true }),
        },
        {
            name: 'qq_set_group_admin',
            description: '设置或取消群成员的管理员身份。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    userId: { type: 'number' },
                    enable: { type: 'boolean', description: 'true=设为管理员，false=取消' },
                },
                required: ['groupId', 'userId', 'enable'],
            },
            run: async (args) => client.call('set_group_admin', { group_id: args.groupId, user_id: args.userId, enable: args.enable === true }),
        },
        {
            name: 'qq_get_group_list',
            description: '获取咱加入的所有群列表（群号、群名、成员数）。',
            parameters: { type: 'object', properties: {} },
            run: async () => {
                // 2026-09-30 容错：新群字段可能不符合旧 schema（invalid output 根因），宽松透传+规范化
                try {
                    const raw = await client.call('get_group_list');
                    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
                    return {
                        count: arr.length,
                        groups: arr.map((g) => ({
                            groupId: Number(g.group_id ?? 0),
                            groupName: String(g.group_name ?? ''),
                            memberCount: Number(g.member_count ?? 0),
                            owner: Number(g.owner_id ?? g.owner ?? 0),
                            raw,
                        })).filter((g) => g.groupId > 0),
                    };
                }
                catch (e) {
                    return { error: String(e).slice(0, 100), hint: '换路：用 qq_get_group_info 单群查询' };
                }
            },
        },
        {
            name: 'qq_get_friend_list',
            description: '获取好友列表（QQ号、昵称、备注）。',
            parameters: { type: 'object', properties: {} },
            run: async () => client.call('get_friend_list'),
        },
        {
            name: 'qq_set_essence',
            description: '设置一条消息为群精华（好好记就收进精华）。',
            parameters: {
                type: 'object',
                properties: { messageId: { type: 'number', description: '消息#编号' } },
                required: ['messageId'],
            },
            run: async (args) => client.call('set_essence_msg', { message_id: args.messageId }),
        },
        {
            name: 'qq_delete_essence',
            description: '移除一条群精华。',
            parameters: {
                type: 'object',
                properties: { messageId: { type: 'number' } },
                required: ['messageId'],
            },
            run: async (args) => client.call('delete_essence_msg', { message_id: args.messageId }),
        },
        {
            name: 'qq_get_essence_list',
            description: '获取群精华消息列表（用于整理精华、翻重要记录）。',
            parameters: {
                type: 'object',
                properties: { groupId: { type: 'number' } },
                required: ['groupId'],
            },
            run: async (args) => client.call('get_essence_msg_list', { group_id: args.groupId }),
        },
        {
            name: 'qq_list_group_files',
            description: '列出群文件系统（文件、文件夹、大小、上传者），用于整理群文件。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    folderId: { type: 'string', description: '文件夹ID，不填=根目录' },
                },
                required: ['groupId'],
            },
            run: async (args) => args.folderId !== undefined
                ? client.call('get_group_files_by_folder', { group_id: args.groupId, folder_id: args.folderId })
                : client.call('get_group_root_files', { group_id: args.groupId }),
        },
        {
            name: 'qq_upload_group_file',
            description: '上传本地文件到群文件系统（可以从咱的工作区里挑文件发）。file 是本地绝对路径。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    file: { type: 'string', description: '本地文件绝对路径' },
                    name: { type: 'string', description: '显示的文件名' },
                    folderId: { type: 'string', description: '目标文件夹ID，不填=根目录' },
                },
                required: ['groupId', 'file'],
            },
            run: async (args) => client.call('upload_group_file', {
                group_id: args.groupId,
                file: String(args.file),
                name: String(args.name ?? String(args.file).replace(/^.*[\\/]/, '')),
                ...(args.folderId !== undefined ? { folder_id: args.folderId } : {}),
            }),
        },
        {
            name: 'qq_download_group_file',
            description: '下载群文件到咱的工作区（先拿链接再存盘），存好返回本地路径。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    fileId: { type: 'string', description: '群文件ID（来自文件列表）' },
                    saveAs: { type: 'string', description: '保存的文件名，存到工作区 downloads/ 下' },
                },
                required: ['groupId', 'fileId'],
            },
            run: async (args) => {
                const urlData = await client.call('get_group_file_url', { group_id: args.groupId, file_id: args.fileId });
                if (typeof urlData?.url !== 'string' || urlData.url === '')
                    throw new Error('拿不到群文件下载链接');
                const res = await fetch(urlData.url);
                if (!res.ok)
                    throw new Error(`下载失败 HTTP ${res.status}`);
                const bytes = Buffer.from(await res.arrayBuffer());
                const fs = await import('node:fs/promises');
                const path = await import('node:path');
                const wsRoot = config.workspacePath ?? process.cwd();
                const dir = path.join(wsRoot, 'downloads');
                await fs.mkdir(dir, { recursive: true });
                const safeName = String(args.saveAs ?? `file_${Date.now()}`).replace(/[\/:*?"<>|]/g, '_');
                const target = path.join(dir, safeName);
                await fs.writeFile(target, bytes);
                return { saved: target, size: bytes.length };
            },
        },
        {
            name: 'qq_create_file_folder',
            description: '在群文件系统里新建文件夹（整理群文件用）。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    folderName: { type: 'string', description: '文件夹名' },
                    parentId: { type: 'string', description: '父文件夹ID，不填=根目录' },
                },
                required: ['groupId', 'folderName'],
            },
            run: async (args) => client.call('create_group_file_folder', {
                group_id: args.groupId,
                folder_name: String(args.folderName),
                parent_id: String(args.parentId ?? '/'),
            }),
        },
        {
            name: 'qq_move_group_file',
            description: '移动群文件（拖动到别的文件夹）。目录ID来自文件列表。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    fileId: { type: 'string', description: '文件ID' },
                    currentParentDirectory: { type: 'string', description: '当前父目录ID' },
                    targetParentDirectory: { type: 'string', description: '目标父目录ID' },
                },
                required: ['groupId', 'fileId', 'currentParentDirectory', 'targetParentDirectory'],
            },
            run: async (args) => client.call('move_group_file', {
                group_id: String(args.groupId),
                file_id: String(args.fileId),
                current_parent_directory: String(args.currentParentDirectory),
                target_parent_directory: String(args.targetParentDirectory),
            }),
        },
        {
            name: 'qq_rename_group_file',
            description: '重命名群文件。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    fileId: { type: 'string' },
                    currentParentDirectory: { type: 'string', description: '当前父目录ID' },
                    newName: { type: 'string', description: '新文件名' },
                },
                required: ['groupId', 'fileId', 'currentParentDirectory', 'newName'],
            },
            run: async (args) => client.call('rename_group_file', {
                group_id: String(args.groupId),
                file_id: String(args.fileId),
                current_parent_directory: String(args.currentParentDirectory),
                new_name: String(args.newName),
            }),
        },
        {
            name: 'qq_delete_group_file',
            description: '删除群文件。慎重使用。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    fileId: { type: 'string' },
                },
                required: ['groupId', 'fileId'],
            },
            run: async (args) => client.call('delete_group_file', { group_id: args.groupId, file_id: String(args.fileId) }),
        },
        {
            name: 'qq_list_emojis',
            description: '列出咱收藏的表情包（本地文件路径）。发表情前先列出来挑一张合适的。',
            parameters: { type: 'object', properties: {} },
            run: async () => {
                if (library !== undefined) {
                    const entries = library.list(40);
                    return {
                        count: entries.length,
                        emojis: entries.map((e) => ({ file: e.file, source: e.source, desc: e.desc, tags: e.tags })),
                    };
                }
                const fs = await import('node:fs/promises');
                const path = await import('node:path');
                const emojiCfg = config.emoji;
                const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
                const dir = emojiCfg.dir ?? path.join(home, 'channel-qq', 'emoji');
                const regDir = emojiCfg.registeredDir ?? path.join(dir, '..', 'emoji-registered');
                const out = [];
                for (const [d, source] of [[regDir, 'registered'], [dir, 'stolen']]) {
                    try {
                        for (const f of await fs.readdir(d)) {
                            if (!f.startsWith('.'))
                                out.push({ file: path.join(d, f), source });
                        }
                    }
                    catch { }
                }
                return { count: out.length, emojis: out.slice(0, 60) };
            },
        },
        {
            name: 'qq_search_emojis',
            description: '按情绪/语义搜索咱收藏的表情包（比如：嘲讽、开心、摸鱼、吃瓜）。返回最匹配的几张的文件路径和描述，用 qq_send_emoji 发送其中 file。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '情绪或语义关键词，如 嘲讽 / 开心 / 吃瓜' },
                    limit: { type: 'number', description: '最多返回几张（默认5）' },
                },
                required: ['query'],
            },
            run: async (args) => {
                if (library === undefined)
                    return { error: '表情库未启用', emojis: [] };
                const hits = library.search(String(args.query ?? ''), Math.min(Number(args.limit ?? 5), 10));
                return { count: hits.length, emojis: hits };
            },
        },
        {
            name: 'qq_emoji_stats',
            description: '看表情库统计：总数、已打标数、常用标签 top10。',
            parameters: { type: 'object', properties: {} },
            run: async () => {
                if (library === undefined)
                    return { error: '表情库未启用' };
                const entries = library.list(100000);
                const tagCount = {};
                let tagged = 0;
                for (const e of entries) {
                    if (e.tags.length > 0)
                        tagged += 1;
                    for (const t of e.tags)
                        tagCount[t] = (tagCount[t] ?? 0) + 1;
                }
                const top = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
                return { total: entries.length, tagged, topTags: top };
            },
        },
        {
            name: 'qq_search_history',
            description: '跨窗口搜索聊天记录：私聊窗口可查群里最近发生的事，群聊窗口可查私聊。支持关键词/发送者/日期过滤，返回带时间戳和#编号的列表。',
            parameters: {
                type: 'object',
                properties: {
                    window: { type: 'string', description: '查哪个窗口：group=群聊 / dm=私聊 / both=两个都查（默认 both）', enum: ['group', 'dm', 'both'] },
                    keyword: { type: 'string', description: '关键词（消息文本包含即命中）' },
                    senderId: { type: 'number', description: '按发送者QQ号过滤' },
                    sinceDate: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
                    untilDate: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
                    limit: { type: 'number', description: '最多返回条数（默认20，上限50）' },
                },
                required: [],
            },
            run: async (args) => {
                const fsMod = await import('node:fs/promises');
                const zlib = await import('node:zlib');
                const pathMod = await import('node:path');
                const home = process.env.DSH_HOME ?? pathMod.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
                const sessRoot = process.env.CHANNEL_QQ_SESSION_ROOT
                    ? (process.env.CHANNEL_QQ_SESSION_ROOT.endsWith(pathMod.sep) ? process.env.CHANNEL_QQ_SESSION_ROOT : process.env.CHANNEL_QQ_SESSION_ROOT + pathMod.sep)
                    : '';
                // 2026-09-28 跨窗口：window 选择查哪些会话（group=主群 / dm=主人私聊 / both），无需精确 sessionId
                const win = String(args.window ?? 'both');
                const targets = [];
                const gSid = 'qq-group-' + String(config.primaryGroup ?? '0');
                const dSid = 'qq-dm-' + String(config.admins[0] ?? '0');
                if (win === 'group' || win === 'both')
                    targets.push({ sid: gSid, label: '群聊' });
                if (win === 'dm' || win === 'both')
                    targets.push({ sid: dSid, label: '私聊' });
                if (args.sessionId !== undefined)
                    targets.push({ sid: String(args.sessionId), label: '指定' });
                if (!sessRoot) {
                    return { content: [{ type: 'text', text: '跨窗口查询未配置：请设置 CHANNEL_QQ_SESSION_ROOT（dsh 会话树目录，如 <DSH_HOME>/sessions/<workspace-encoded>/）' }] };
                }
                const decFile = async (sid) => {
                    const file = sessRoot + sid + pathMod.sep + 'session.v3.jsonl.zstd';
                    let buf;
                    try {
                        buf = await fsMod.readFile(file);
                    }
                    catch {
                        return null;
                    }
                    // 2026-09-28 修复 v2：node 流式 zstd 不解拼接帧（停在第一帧）→ 按帧魔数 28B52FFD 切分逐帧 sync 解压拼接（实测 1238 帧全解）
                    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
                    const frames = [];
                    let pos = buf.indexOf(MAGIC);
                    while (pos !== -1) {
                        const next = buf.indexOf(MAGIC, pos + 1);
                        frames.push(next === -1 ? buf.subarray(pos) : buf.subarray(pos, next));
                        pos = next;
                    }
                    let jsonl = '';
                    for (const f of frames) {
                        try {
                            jsonl += zlib.zstdDecompressSync(f).toString('utf8');
                        }
                        catch { /* 跳过损坏帧 */ }
                    }
                    return jsonl;
                };
                const keyword = args.keyword === undefined ? null : String(args.keyword);
                const sender = args.senderId === undefined ? null : Number(args.senderId);
                const since = args.sinceDate === undefined ? null : String(args.sinceDate);
                const until = args.untilDate === undefined ? null : String(args.untilDate);
                const limit = Math.min(Number(args.limit ?? 20), 50);
                const hits = [];
                for (const t of targets) {
                    const jsonl = await decFile(t.sid);
                    if (jsonl === null)
                        continue;
                    for (const line of jsonl.split('\n')) {
                        if (!line.includes('"type":"user/message"'))
                            continue;
                        try {
                            const e = JSON.parse(line);
                            const content = e.data?.content;
                            if (!Array.isArray(content))
                                continue;
                            const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ');
                            if (text === '')
                                continue;
                            const iso = new Date(e.time).toISOString().slice(0, 10);
                            if (since !== null && iso < since)
                                continue;
                            if (until !== null && iso > until)
                                continue;
                            if (keyword !== null && !text.includes(keyword))
                                continue;
                            const src = e.data?.source ?? {};
                            const uid = Number(src.userId ?? src.user_id ?? 0);
                            if (sender !== null && uid !== sender)
                                continue;
                            const senderName = e.data?.senderName ?? String(uid);
                            hits.push({ window: t.label, time: new Date(e.time).toISOString(), sender: senderName, userId: uid, msgId: '#' + String(e.data?.messageId ?? e.seq), text: text.slice(0, 300) });
                            if (hits.length >= limit)
                                break;
                        }
                        catch {
                            continue;
                        }
                    }
                    if (hits.length >= limit)
                        break;
                }
                hits.sort((a, b) => (a.time < b.time ? -1 : 1));
                return { count: hits.length, hits: hits.slice(0, limit) };
            },
        },
        {
            name: 'qq_send_voice',
            description: '把一段本地音频文件当语音条发出去（mp3/wav等常规格式均可，NapCat 自动转 silk）。想用自定义音色就先用外部 TTS 生成音频文件再发。',
            parameters: {
                type: 'object',
                properties: {
                    isGroup: { type: 'boolean' },
                    target: { type: 'number', description: '群号或对方QQ号' },
                    file: { type: 'string', description: '本地音频文件绝对路径（mp3/wav/silk等）' },
                },
                required: ['isGroup', 'target', 'file'],
            },
            run: async (args) => {
                const message = [{ type: 'record', data: { file: `file://${args.file}` } }];
                return args.isGroup === true
                    ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
                    : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }));
            },
        },
        {
            name: 'qq_can_send_voice',
            description: '检测当前 QQ 实例是否具备发语音条的能力。',
            parameters: { type: 'object', properties: {} },
            run: async () => client.call('can_send_record'),
        },
        {
            name: 'qq_send_ai_voice',
            description: 'QQ自带AI语音（百变变声器）：选一个音色把文字念成语音条发到群里。character 是QQ音色ID（如 ai_char_1 这类，不存在的会报错，换一个试）。仅限群聊。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number' },
                    character: { type: 'string', description: 'QQ音色ID，如 ai_char_1' },
                    text: { type: 'string', description: '要念的文字，别太长' },
                },
                required: ['groupId', 'character', 'text'],
            },
            run: async (args) => out.push(() => gatedCall('send_group_ai_record', {
                character: String(args.character),
                group_id: String(args.groupId),
                text: String(args.text ?? ''),
            })),
        },
        {
            name: 'qq_get_ai_voice_url',
            description: '获取QQ AI语音的音频URL（不发出去）。配合下载后可用 qq_send_voice 当语音条发到任意会话——这是私聊用AI音色的办法。',
            parameters: {
                type: 'object',
                properties: {
                    groupId: { type: 'number', description: 'AI语音按群开通，传群号' },
                    character: { type: 'string', description: 'QQ音色ID' },
                    text: { type: 'string' },
                },
                required: ['groupId', 'character', 'text'],
            },
            run: async (args) => gatedCall('get_ai_record', {
                character: String(args.character),
                group_id: String(args.groupId),
                text: String(args.text ?? ''),
            }),
        },
        {
            name: 'qq_get_ai_characters',
            description: '列出QQ自带的AI变声音色列表（按群开通）。character 参数从这里选。',
            parameters: {
                type: 'object',
                properties: { groupId: { type: 'number', description: '群号' } },
                required: ['groupId'],
            },
            run: async (args) => gatedCall('get_ai_characters', { group_id: String(args.groupId ?? ''), chat_type: 1 }),
        },
        {
            name: 'qq_fetch_ptt_text',
            description: '语音条转文字（QQ 原生转写）：把任意一条语音消息的消息 ID 转成文字。收到语音条时系统已自动转好注入对话；这个工具用于事后补查历史语音。',
            parameters: {
                type: 'object',
                properties: { messageId: { type: 'number', description: '语音消息的消息 ID' } },
                required: ['messageId'],
            },
            run: async (args) => gatedCall('fetch_ptt_text', { message_id: Number(args.messageId) }),
        },
        {
            name: 'qq_get_file_url',
            description: '拿私聊/群文件的下载链接（fileId 来自文件消息或群文件列表）。',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'string', description: '文件ID' },
                },
                required: ['fileId'],
            },
            run: async (args) => client.call('get_private_file_url', { file_id: String(args.fileId) }),
        },
        {
            name: 'qq_send_private_file',
            description: '私聊给好友发本地文件（从咱的工作区里挑）。file 是本地绝对路径；不填 name 就用原文件名。',
            parameters: {
                type: 'object',
                properties: {
                    userId: { type: 'number', description: '好友QQ号' },
                    file: { type: 'string', description: '本地文件绝对路径' },
                    name: { type: 'string', description: '显示的文件名' },
                },
                required: ['userId', 'file'],
            },
            run: async (args) => {
                const file = String(args.file);
                const fsMod = await import('node:fs/promises');
                await fsMod.access(file);
                return client.call('upload_private_file', {
                    user_id: args.userId,
                    file,
                    name: String(args.name ?? file.replace(/^.*[\\/]/, '')),
                });
            },
        },
        {
            name: 'qq_save_private_file',
            description: '把私聊收到的文件存到咱的工作区 downloads/ 下（fileId 来自文件消息），返回本地路径。',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'string', description: '私聊文件ID' },
                    saveAs: { type: 'string', description: '保存的文件名，存到工作区 downloads/ 下' },
                },
                required: ['fileId'],
            },
            run: async (args) => {
                const urlData = await client.call('get_private_file_url', { file_id: String(args.fileId) });
                if (typeof urlData?.url !== 'string' || urlData.url === '')
                    throw new Error('拿不到私聊文件下载链接');
                const res = await fetch(urlData.url);
                if (!res.ok)
                    throw new Error(`下载失败 HTTP ${res.status}`);
                const bytes = Buffer.from(await res.arrayBuffer());
                const fsMod = await import('node:fs/promises');
                const pathMod = await import('node:path');
                const wsRoot = config.workspacePath ?? process.cwd();
                const dir = pathMod.join(wsRoot, 'downloads');
                await fsMod.mkdir(dir, { recursive: true });
                const safeName = String(args.saveAs ?? `file_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
                const target = pathMod.join(dir, safeName);
                await fsMod.writeFile(target, bytes);
                return { saved: target, size: bytes.length };
            },
        },
        {
            name: 'qq_search_music',
            description: '搜索网易云音乐（歌名/歌手）。返回 id、歌名、歌手、时长列表，供点歌时选歌。',
            parameters: {
                type: 'object',
                properties: {
                    keyword: { type: 'string', description: '歌名或歌手' },
                    limit: { type: 'number', description: '返回条数（默认5，最多10）' },
                },
                required: ['keyword'],
            },
            run: async (args) => {
                const songs = await neteaseSearch(String(args.keyword), Math.min(Number(args.limit ?? 5), 10));
                return { count: songs.length, songs };
            },
        },
        {
            name: 'qq_resolve_music',
            description: '解析一首歌的播放直链/封面/歌词（网易云 songId）。发语音或拿链接前用这个。',
            parameters: {
                type: 'object',
                properties: { songId: { type: 'string', description: '网易云歌曲ID（必填）' } },
                required: ['songId'],
            },
            run: async (args) => {
                const br = Math.min(Number(args.br ?? 320000), 999000);
                const result = await neteaseSongUrl(String(args.songId), br);
                if (result.url === null) {
                    throw new Error(result.vipRequired ? '该曲为 VIP/付费歌曲：请先 qq_netease_login 扫码登录会员账号' : '拿不到播放直链（下架或地区限制）');
                }
                return { audioUrl: result.url, quality: result.br, fee: result.fee, size: result.size };
            },
        },
        {
            name: 'qq_send_music_card',
            description: '在群/私聊里发一首歌（正版音乐卡片，网易云 songId）。卡片试听直链走主人的网易云 VIP 账号官方解析（br 可调，默认 320k）。mode=auto(默认)卡片被吞自动降级语音条；mode=card 只发卡不降级；mode=voice 直接发语音条。',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'number', description: '群号或好友QQ号' },
                    songId: { type: 'string', description: '网易云歌曲ID' },
                    private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
                    br: { type: 'number', description: '卡片试听音质（默认 320000，VIP 无损 999000）' },
                    mode: { type: 'string', description: 'auto=卡失败降语音（默认）/ card=只发卡 / voice=只发语音条' },
                },
                required: ['target', 'songId'],
            },
            run: async (args) => {
                // NapCat 自带 music 段拿裸载荷走 JSON POST 给签名站必被拒（"消息体无法解析"），
                // 所以插件自签自发 json 段；试听直链优先走主人 VIP 官方解析；发完对账。
                // 注意：官方解析管"曲子是 VIP 全曲"，卡片能否"下发"是 QQ 服务端对 ark 卡的另一道
                // 静默风控（签名只保提交关）——吞卡与解析源无关，私聊 c2c 场景最严。
                const isPrivate = args.private === true;
                const mode = args.mode === 'voice' || args.mode === 'card' ? args.mode : 'auto';
                if (mode === 'voice') {
                    return sendMusicVoiceTo(Number(args.target), isPrivate, String(args.songId));
                }
                const br = Math.min(Number(args.br ?? 320000), 999000);
                let audioUrl = null;
                try {
                    audioUrl = (await neteaseSongUrl(String(args.songId), br)).url;
                }
                catch {
                    // cookie/网络问题不挡卡片——降级用签名站自带的公共试听链
                }
                const { card, chain } = await signMusicCard(String(args.songId), { audioUrl, meta: () => neteaseSongDetail(String(args.songId)) });
                log(`music card: song=${String(args.songId)} chain=${chain} br=${br} private=${isPrivate} target=${String(args.target)}`);
                const segment = [{ type: 'json', data: card }];
                let sendResult;
                try {
                    sendResult = isPrivate
                        ? await client.call('send_private_msg', { user_id: args.target, message: segment })
                        : await client.call('send_group_msg', { group_id: args.target, message: segment });
                }
                catch (e) {
                    // NapCat 等 onMsgInfoListUpdate 超时会在这里抛 Timeout，但原生层 result:0=已提交——
                    // 真发没发出去以历史对账为准，不在这里直接判死。
                    sendResult = e;
                }
                let arrived = false;
                for (let i = 0; i < 3; i++) {
                    await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 2000));
                    arrived = await cardArrived(Number(args.target), isPrivate, String(args.songId));
                    if (arrived !== false)
                        break;
                }
                if (arrived === true) {
                    const base = sendResult instanceof Error
                        ? { ok: true, verified: true, chain, note: '卡片已送达（NapCat 回执监听超时是误报）', errorText: sendResult.message.slice(0, 120) }
                        : { ok: true, verified: true, chain, ...sendResult };
                    return base;
                }
                if (mode === 'card') {
                    throw new Error(`音乐卡片未被下发（chain=${chain}，QQ 服务端 ark 风控吞卡${arrived === 'unknown' ? '，历史对账接口不可用' : isPrivate ? '，私聊 c2c 最严' : '，群聊也被吞'}）——可换 mode=auto/voice 或先试群聊`);
                }
                if (arrived === 'unknown') {
                    log('music card: verify unavailable, degrading to voice anyway');
                }
                await sendMusicVoiceTo(Number(args.target), isPrivate, String(args.songId));
                return { ok: true, degraded: true, chain, note: '音乐卡片未确认送达（QQ 服务端 ark 风控），已自动改发语音条' };
            },
        },
        {
            name: 'qq_send_music_voice',
            description: '把一首歌下载后以语音形式发到群/私聊（卡片发不了时的降级，听感像发语音条）。',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'number', description: '群号或好友QQ号' },
                    songId: { type: 'string', description: '网易云歌曲ID' },
                    private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
                },
                required: ['target', 'songId'],
            },
            run: async (args) => {
                return sendMusicVoiceTo(Number(args.target), args.private === true, String(args.songId));
            },
        },
        {
            name: 'qq_music_lyrics',
            description: '拿一首歌的完整歌词（网易云 songId）。',
            parameters: {
                type: 'object',
                properties: { songId: { type: 'string', description: '网易云歌曲ID（必填）' } },
                required: ['songId'],
            },
            run: async (args) => {
                const res = await fetch(`https://api.qijieya.cn/meting/?server=netease&type=lrc&id=${encodeURIComponent(String(args.songId))}`);
                if (!res.ok)
                    throw new Error(`歌词获取失败 HTTP ${res.status}`);
                const text = await res.text();
                // meting returns JSON array with lrc field when Accept: json
                try {
                    const list = JSON.parse(text);
                    return { lyrics: (list[0]?.lrc ?? text).slice(0, 6000) };
                }
                catch {
                    return { lyrics: text.slice(0, 6000) };
                }
            },
        },
        {
            name: 'qq_music_playlist',
            description: '咱的个人歌单（跨重启持久）。action: add/remove/list/clear。add 需要 songId 和 name。',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'add / remove / list / clear' },
                    songId: { type: 'string' },
                    name: { type: 'string', description: '歌名（add 时记录）' },
                    artists: { type: 'string', description: '歌手（add 时可选）' },
                },
                required: ['action'],
            },
            run: async (args) => {
                const fsMod = await import('node:fs/promises');
                const pathMod = await import('node:path');
                const wsRoot = config.workspacePath ?? process.cwd();
                const file = pathMod.join(wsRoot, 'music-playlist.json');
                let songs = [];
                try {
                    songs = JSON.parse(await fsMod.readFile(file, 'utf8'));
                }
                catch {
                    songs = [];
                }
                const action = String(args.action);
                if (action === 'add') {
                    if (songs.some((s) => s.id === String(args.songId)))
                        return { result: '歌单里已有这首', total: songs.length };
                    songs.unshift({ id: String(args.songId), name: String(args.name ?? ''), artists: args.artists === undefined ? undefined : String(args.artists), addedAt: Date.now() });
                }
                else if (action === 'remove') {
                    songs = songs.filter((s) => s.id !== String(args.songId));
                }
                else if (action === 'clear') {
                    songs = [];
                }
                else if (action !== 'list') {
                    return { error: 'action 只能是 add/remove/list/clear' };
                }
                await fsMod.writeFile(file, JSON.stringify(songs, null, 1), 'utf8');
                return { action, total: songs.length, songs: songs.slice(0, 30) };
            },
        },
        {
            name: 'qq_netease_login',
            description: '网易云会员登录。action=start 返回二维码链接（发给主人用网易云App扫码）；action=poll 用返回的 key 轮询，成功后自动保存会员 Cookie（VIP歌就能发了）。Cookie 持久保存，不用每次登。',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'start（拿二维码）/ poll（查状态，带 key）' },
                    key: { type: 'string', description: 'poll 时传 start 返回的 key' },
                },
                required: ['action'],
            },
            run: async (args) => {
                const action = String(args.action);
                if (action === 'start') {
                    const { unikey, qrUrl } = await qrLoginStart();
                    return { key: unikey, qrUrl, hint: '把 qrUrl 发给主人，用网易云音乐App扫码；然后每2秒调一次 action=poll' };
                }
                if (action === 'poll') {
                    const result = await qrLoginPoll(String(args.key ?? ''));
                    if (result.code === 803 && result.cookie !== '') {
                        await neteaseSaveCookie(result.cookie);
                        return { status: '登录成功，会员Cookie已保存', cookieSaved: true };
                    }
                    const meaning = { 800: '二维码已过期，重新 start', 801: '等待扫码', 802: '已扫码待确认', [-1]: '轮询异常' };
                    return { status: meaning[result.code] ?? (`code=${result.code} ${result.message}`), code: result.code };
                }
                return { error: 'action 只能是 start/poll' };
            },
        },
        {
            name: 'qq_netease_status',
            description: '查网易云账号登录状态和会员等级（判断 VIP 歌能不能发）。',
            parameters: { type: 'object', properties: {} },
            run: async () => neteaseLoginStatus(),
        },
        {
            name: 'qq_kugou_search',
            description: '搜索酷狗音乐（歌名/歌手）。返回 hash、歌名、歌手，供酷狗点歌用。需要先 qq_kugou_login 登录（酷狗禁止匿名搜索）。',
            parameters: {
                type: 'object',
                properties: {
                    keyword: { type: 'string', description: '歌名或歌手' },
                    limit: { type: 'number', description: '返回条数（默认5，最多10）' },
                },
                required: ['keyword'],
            },
            run: async (args) => {
                const songs = await kugouSearch(String(args.keyword), Math.min(Number(args.limit ?? 5), 10));
                return { count: songs.length, songs };
            },
        },
        {
            name: 'qq_kugou_send',
            description: '发酷狗歌曲：默认发语音条（VIP歌需要先 qq_kugou_login）。quality 可选 auto/viper_tape/viper_clear/super/high/flac/320/128。',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'number', description: '群号或好友QQ号' },
                    hash: { type: 'string', description: '歌曲hash（来自 qq_kugou_search）' },
                    quality: { type: 'string', description: '音质（默认 auto）' },
                    private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
                },
                required: ['target', 'hash'],
            },
            run: async (args) => {
                const resolved = await kugouSongUrl(String(args.hash), String(args.quality ?? 'auto'));
                const audio = await fetch(resolved.url);
                if (!audio.ok)
                    throw new Error(`音频下载失败 HTTP ${audio.status}`);
                const fsMod = await import('node:fs/promises');
                const pathMod = await import('node:path');
                const tmpDir = pathMod.join(process.env.DSH_HOME ?? 'C:\\Users\\Administrator\\.dsh', 'channel-qq', 'music-tmp');
                await fsMod.mkdir(tmpDir, { recursive: true });
                const target = pathMod.join(tmpDir, `kg_${Date.now()}.${resolved.extName}`);
                await fsMod.writeFile(target, Buffer.from(await audio.arrayBuffer()));
                const segment = [{ type: 'record', data: { file: `file:///${target.replace(/\\/g, '/')}` } }];
                const result = (args.private === true
                    ? await client.call('send_private_msg', { user_id: args.target, message: segment })
                    : await client.call('send_group_msg', { group_id: args.target, message: segment }));
                void fsMod.rm(target, { force: true }).catch(() => { });
                return { ...result, trial: resolved.trial, quality: String(args.quality ?? 'auto') };
            },
        },
        {
            name: 'qq_kugou_login',
            description: '酷狗音乐登录。action=start 拿二维码链接（发给主人用酷狗App扫码）；action=poll 轮询，成功自动保存 Cookie（VIP歌+搜索就通了）。',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'start / poll' },
                    key: { type: 'string', description: 'poll 时传 start 返回的 key' },
                },
                required: ['action'],
            },
            run: async (args) => {
                const action = String(args.action);
                if (action === 'start') {
                    const { key, qrUrl } = await kugouQrStart();
                    return { key, qrUrl, hint: '把 qrUrl 发给主人，用酷狗App扫码；然后每2秒调一次 action=poll' };
                }
                if (action === 'poll') {
                    const result = await kugouQrPoll(String(args.key ?? ''));
                    if (result.status === 'ok') {
                        return { status: '登录成功，酷狗Cookie已保存', nickname: result.nickname, cookieSaved: true };
                    }
                    const meaning = { 0: '等待扫码', 1: '已扫码待确认' };
                    return { status: meaning[result.status] ?? `status=${result.status}` };
                }
                return { error: 'action 只能是 start/poll' };
            },
        },
        {
            name: 'qq_send_like',
            description: '给好友点赞。',
            parameters: {
                type: 'object',
                properties: { userId: { type: 'number' }, times: { type: 'number', description: '点赞次数（≤10）' } },
                required: ['userId'],
            },
            run: async (args) => client.call('send_like', { user_id: args.userId, times: Math.min(Number(args.times ?? 1), 10) }),
        },
        {
            name: 'qq_swarm',
            description: [
                '【共演算·并行编排】一次调用同时派发多个 QQ 动作，并发执行、统一收账。',
                '适用：同一回合里要多线并进的时候（同时查多个群信息+给主人点赞+发一条消息等），不用一条条等。',
                'actions 每项 = { action: OneBot动作名, params: 该动作的参数对象, label: 给自己看的标签 }。',
                '动作名就是底层 OneBot action（send_private_msg/send_group_msg/get_group_info/send_like/set_msg_emoji_like 等）。',
                '私聊消息用 send_private_msg{user_id,message:[{type:"text",data:{text:"…"}}]}，群消息用 send_group_msg{group_id,message:…}，',
                '窗口白名单照旧生效（私聊仅主人，群仅主群/游历群）。结果按顺序返回，每项带 ok/label/result/error。',
                '注意：并行只用于互不依赖的动作；有依赖关系（先查再发）的还是分轮次来。',
            ].join('\n'),
            parameters: {
                type: 'object',
                properties: {
                    actions: {
                        type: 'array',
                        description: '要并行派发的动作列表（2-8 个为宜）',
                        items: {
                            type: 'object',
                            properties: {
                                action: { type: 'string', description: 'OneBot action 名' },
                                params: { type: 'object', description: '该动作的参数' },
                                label: { type: 'string', description: '动作标签（给自己看的备注）' },
                            },
                            required: ['action'],
                        },
                    },
                },
                required: ['actions'],
            },
            run: async (args) => {
                const raw = Array.isArray(args.actions) ? args.actions : [];
                if (raw.length === 0)
                    return { ok: false, error: 'actions 为空' };
                if (raw.length > 12)
                    return { ok: false, error: '一次最多 12 个动作，贪多嚼不烂' };
                // 窗口白名单复用：send 类动作在派发前校验目标，防串窗
                const primaryGroup = config.primaryGroup;
                const extraGroups = config.extraGroups ?? [];
                const admins = config.admins;
                const checked = raw.map((a) => {
                    const action = String(a.action ?? '');
                    const params = (a.params ?? {});
                    const label = String(a.label ?? action);
                    if (/^send_(private|group)_msg$/.test(action)) {
                        const isGroup = action === 'send_group_msg';
                        const target = Number(isGroup ? params.group_id : params.user_id);
                        const allowed = isGroup
                            ? target === primaryGroup || extraGroups.includes(target)
                            : admins.includes(target);
                        if (!allowed)
                            return { action, params, label, blocked: `窗口白名单拒绝：目标 ${target} 不在允许列表` };
                    }
                    return { action, params, label, blocked: null };
                });
                const results = await Promise.all(checked.map(async (item) => {
                    if (item.blocked)
                        return { label: item.label, action: item.action, ok: false, error: item.blocked };
                    try {
                        const r = await client.call(item.action, item.params);
                        return { label: item.label, action: item.action, ok: true, result: r ?? null };
                    }
                    catch (e) {
                        return { label: item.label, action: item.action, ok: false, error: e instanceof Error ? e.message : String(e) };
                    }
                }));
                const okCount = results.filter(r => r.ok).length;
                return { ok: okCount > 0, total: results.length, succeeded: okCount, failed: results.length - okCount, results };
            },
        },
    ];
    for (const spec of specs) {
        try {
            disposers.push(tools.register({
                name: spec.name,
                description: spec.description,
                parameters: spec.parameters,
                output: {
                    schema: { type: 'object' },
                    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
                },
                async execute(args) {
                    const value = await spec.run((args ?? {}));
                    // OneBot mutation actions frequently answer null/undefined even on
                    // success. Normalize every void-ish result to a lossless JSON ack so
                    // the harness output validator does not turn success into an error.
                    if (value === undefined || value === null) {
                        return { ok: true };
                    }
                    return value;
                },
            }));
        }
        catch (error) {
            log(`tool ${spec.name} registration failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    log(`registered ${disposers.length} QQ tools`);
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
