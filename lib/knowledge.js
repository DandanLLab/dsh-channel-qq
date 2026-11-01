/** Stage-2 knowledge pipeline: auto-extract from diaries/group chats into
 * structured entries, keyword+weight retrieval, persists to workspace/knowledge/.
 *
 * Extractor: none (2026-09-26 master order) — knowledge entries are composed by the main model itself via extract_knowledge tool; no external API.
 * Retrieval: keyword overlap + recency + weight scoring (vector upgrade later).
 *
 * 2026-11-01 温度生命周期改造（管理员令"冷记忆热记忆动态记忆实时记忆有效记忆过期记忆"）:
 *   - 温度 = 热命中/温近作/冷沉睡（由 lastHitAt 推导，不落盘）
 *   - 有效性 = active / superseded(被替换,降级不删) / expired(过期,默认不召回)
 *   - supersede 语义（engram 拆解）：旧真相降级永留，可重取
 *   - 纠正/偏好句式捕获器（零LLM，engram 拆解）：管理员的"不要X/改用X/以后统一X"自动沉淀 preference
 *   - 密钥脱敏器（engram 拆解）：写入前先打码再哈希再落盘
 *   - 失败→解法闭环：error 条目带 cmd 签名，同命令跑通自动沉淀 procedure
 *   - KB 连接：save() 时投影 entries-digest.md → kb.cjs 向量索引自动覆盖记忆库（管理员令"KB组件和记忆库完美连接"）
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
let knSeq = 0;
/** 确定性密钥脱敏器（engram 拆解）：API key/JWT/Bearer/key=value 形密钥 → <REDACTED:…>，写入前先于一切落盘。 */
export function redact(text) {
    return text
        .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '<REDACTED:key>')
        .replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<REDACTED:github>')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1<REDACTED:token>')
        .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,})\b/g, '<REDACTED:jwt>')
        .replace(/\b(AKIA[0-9A-Z]{16})\b/g, '<REDACTED:aws>')
        .replace(/\b([A-Za-z_][A-Za-z0-9_]*_(?:key|token|secret))\s*[=:]\s*["']?[A-Za-z0-9._-]{12,}["']?/gi, '$1=<REDACTED>');
}
/** 温度推导：热=24h 内命中/诞生；温=7 天内；冷=更老。 */
export function tempOf(e, now = Date.now()) {
    const last = Math.max(e.lastHitAt ?? 0, e.created);
    const age = now - last;
    if (age <= 24 * 3600_000)
        return 'hot';
    if (age <= 7 * 24 * 3600_000)
        return 'warm';
    return 'cold';
}
const DAY = 24 * 3600_000;
/** 纠正/偏好句式（engram 拆解，中文为主）：三方向 avoid/switch-to/prefer。 */
const PREFERENCE_PATTERNS = [
    { re: /不要(?:再?|以后)?(用|做|加|发|写|说|带)\s*[「"']?([^。！？,，;；\n]{2,24})[」"']?/g, dir: 'avoid' },
    { re: /别(?:再?)?(用|做|加|发|写|说|带)\s*[「"']?([^。！？,，;；\n]{2,24})[」"']?/g, dir: 'avoid' },
    { re: /(?:以后|下次|以后都|统一)?改用\s*[「"']?([^。！？,，;；\n]{2,24})[」"']?/g, dir: 'switch-to' },
    { re: /(?:以后|下次|都)?换成\s*[「"']?([^。！？,，;；\n]{2,24})[」"']?/g, dir: 'switch-to' },
    { re: /以后(?:都|统一|一律)\s*(?:用|按)\s*[「"']?([^。！？,，;；\n]{2,24})[」"']?/g, dir: 'prefer' },
    { re: /(?:优先|尽量|记得)\s*(?:用|按)\s*[「"']?([^。！？,，;；\n]{2,24})[」"']?/g, dir: 'prefer' },
    { re: /(?<!不|别|少)(?:就|要)\s*(?:用|按)\s*[「"']?([^。！？,，;；\n]{2,24})[」"']?/g, dir: 'prefer' },
];
/** 误报过滤器：疑问句 / 一次性操作 / 记忆元话语 不入偏好库。 */
function preferenceNoise(text) {
    if (/[?？]\s*$/.test(text.trim()))
        return true;
    if (/这(?:次|回|个文件|条消息)|刚才那个|先别|暂时/.test(text))
        return true;
    if (/记忆|knowledge|entries|偏好库/.test(text))
        return true;
    return false;
}
/** 知识条目库：entries.json 持久化（去重），检索=关键词命中*3+权重*2+新近度+温度。 */
export class KnowledgeStore {
    log;
    entries = [];
    file;
    constructor(dshHome, workspace, log) {
        this.log = log;
        const dir = workspace && workspace.length > 0 ? path.join(workspace, 'knowledge') : path.join(dshHome, 'knowledge');
        this.file = path.join(dir, 'entries.json');
    }
    async load() {
        try {
            const raw = await fs.readFile(this.file, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.entries = parsed.filter((x) => typeof x === 'object' && x !== null && typeof x.content === 'string');
                this.log(`knowledge: loaded ${this.entries.length} entries`);
            }
        }
        catch {
            this.entries = [];
            this.log('knowledge: empty store (no entries.json yet)');
        }
    }
    async save() {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(this.entries, null, 2), 'utf-8');
        await fs.rename(tmp, this.file);
        // KB 完美连接（管理员令）：投影 entries-digest.md → kb.cjs 向量索引自动覆盖记忆库。
        // 每次落盘顺手重写（原子小文件，索引器只收 .md）；state/temp 标记写进行文供召回降权参考。
        try {
            const lines = ['# 记忆条目投影(entries.json 自动生成，勿手编)', ''];
            for (const e of this.entries) {
                if ((e.state ?? 'active') === 'expired')
                    continue;
                const st = (e.state ?? 'active') === 'superseded' ? '[已被替换]' : '';
                const temp = tempOf(e);
                lines.push(`- [${e.type}/${temp}${st}] ${redact(e.content).slice(0, 160)}`);
            }
            await fs.writeFile(this.file.replace(/entries\.json$/, 'entries-digest.md'), lines.join('\n'), 'utf-8');
        }
        catch (err) {
            this.log(`knowledge digest projection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 去重入库（按 content 精确匹配），返回新增条数。写入一律先脱敏。 */
    async addMany(items) {
        const seen = new Set(this.entries.map(e => e.content.trim()));
        let added = 0;
        for (const it of items) {
            const content = redact(it.content.trim());
            if (content.length < 4 || seen.has(content))
                continue;
            seen.add(content);
            knSeq += 1;
            this.entries.push({
                id: `kn-${Date.now().toString(36)}-${knSeq}`,
                type: 'fact',
                content,
                tags: it.tags,
                source: it.source,
                created: Date.now(),
                weight: 1,
                hits: 0,
                state: 'active',
            });
            added += 1;
        }
        if (added > 0)
            await this.save();
        return added;
    }
    /**
     * 温度生命周期检索：命中数*3 + 权重*2 + 温度加成 + 新近度。
     * active 全分；superseded 打 0.15 折沉底（engram：降级不删）；expired 直接排除；
     * 过期线 expiresAt 一过自动按 expired 处理（惰性标记）。
     */
    search(query, limit) {
        const q = query.toLowerCase();
        const terms = q.split(/[\s，。、！？,.!?]+/).filter(t => t.length > 0);
        const now = Date.now();
        const scored = this.entries.map(e => {
            const st = e.state ?? 'active';
            if (st === 'expired')
                return { e, score: 0 };
            if (e.expiresAt !== undefined && e.expiresAt < now) {
                e.state = 'expired';
                return { e, score: 0 };
            }
            const hay = (e.content + ' ' + e.tags.join(' ')).toLowerCase();
            let hits = 0;
            for (const t of terms)
                if (hay.includes(t))
                    hits += 1;
            if (hits === 0)
                return { e, score: 0 };
            const temp = tempOf(e, now);
            const tempBoost = temp === 'hot' ? 2 : temp === 'warm' ? 1 : 0;
            const last = Math.max(e.lastHitAt ?? 0, e.created);
            const recency = (last - 1700000000000) / (now - 1700000000000 + 1);
            const base = hits * 3 + e.weight * 2 + tempBoost + recency * 1 + (e.confidence ?? 1);
            return { e, score: st === 'superseded' ? base * 0.15 : base };
        }).filter(x => x.score > 0);
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(x => x.e);
    }
    /** 压顶偏好：active 的 preference，按权重×新近排序（engram：管理员规则=每会话第一行）。 */
    preferences(limit) {
        return this.entries
            .filter(e => e.type === 'preference' && (e.state ?? 'active') === 'active')
            .sort((a, b) => (b.weight * 10 + (b.lastHitAt ?? b.created) / DAY) - (a.weight * 10 + (a.lastHitAt ?? a.created) / DAY))
            .slice(0, limit);
    }
    /** 当前条目数。 */
    size() {
        return this.entries.length;
    }
    /** 命中强化：权重 +1、热度刷新（读路径加热：cold→warm→hot 由 tempOf 自动体现）。 */
    async reinforce(id) {
        const e = this.entries.find(x => x.id === id);
        if (e === undefined)
            return;
        e.weight += 1;
        e.hits += 1;
        e.lastHitAt = Date.now();
        try {
            await this.save();
        }
        catch (err) {
            this.log(`knowledge reinforce save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** supersede（engram 拆解）：旧真相降级不删，新条目占位。 */
    async supersede(oldId, newId) {
        const old = this.entries.find(x => x.id === oldId);
        if (old === undefined || !this.entries.some(x => x.id === newId))
            return false;
        old.state = 'superseded';
        old.supersededBy = newId;
        try {
            await this.save();
        }
        catch {
            return false;
        }
        return true;
    }
    /** 过期：立即置 expired（留档可考古，默认不召回）。 */
    async expire(id) {
        const e = this.entries.find(x => x.id === id);
        if (e === undefined)
            return false;
        e.state = 'expired';
        try {
            await this.save();
        }
        catch {
            return false;
        }
        return true;
    }
    /**
     * P1 纠正/偏好句式捕获器（零LLM）：从管理员消息文本沉淀 preference 条目。
     * 返回新增条数；去重按"方向+内容"，同样的话只记一次，重复出现 weight+1。
     */
    async captureFromMessage(text, source) {
        if (text.length < 4 || text.length > 800)
            return 0;
        if (preferenceNoise(text))
            return 0;
        let added = 0;
        for (const { re, dir } of PREFERENCE_PATTERNS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text)) !== null) {
                const tail = (m[2] ?? m[1] ?? '').trim();
                if (tail.length < 2)
                    continue;
                const content = redact(`管理员要求${dir === 'avoid' ? '避免' : dir === 'switch-to' ? '改用' : '优先'}：${tail}`);
                const dup = this.entries.find(e => e.type === 'preference' && e.content === content);
                if (dup !== undefined) {
                    dup.weight += 1;
                    dup.lastHitAt = Date.now();
                    continue;
                }
                knSeq += 1;
                this.entries.push({
                    id: `pref-${Date.now().toString(36)}-${knSeq}`,
                    type: 'preference',
                    content,
                    tags: ['preference', dir, '管理员纠正'],
                    source,
                    created: Date.now(),
                    weight: 3,
                    hits: 0,
                    state: 'active',
                    confidence: 0.8,
                });
                added += 1;
            }
        }
        if (added > 0) {
            this.log(`knowledge: captured ${added} preference(s) from message`);
            await this.save();
        }
        return added;
    }
    /** P4 失败→解法闭环：error 条目带 cmd:<命令> 标签，命令跑通时沉淀 procedure 并闭环旧 error。 */
    async promoteProcedure(cmd, note, source) {
        const tag = `cmd:${cmd}`;
        const errs = this.entries.filter(e => e.type === 'error' && e.tags.includes(tag) && (e.state ?? 'active') === 'active');
        if (errs.length === 0)
            return 0;
        let closed = 0;
        for (const e of errs) {
            e.state = 'expired';
            e.tags.push('resolved');
            closed += 1;
        }
        const content = redact(`已解决：${cmd} — ${note}（此前失败 ${errs.length} 次）`);
        knSeq += 1;
        this.entries.push({
            id: `proc-${Date.now().toString(36)}-${knSeq}`,
            type: 'procedure',
            content,
            tags: ['procedure', tag],
            source,
            created: Date.now(),
            weight: 3,
            hits: 0,
            state: 'active',
        });
        if (closed > 0)
            await this.save();
        return closed;
    }
    /** 生命周期体检：各温度/状态计数（运维观测用）。 */
    lifecycleStats() {
        const now = Date.now();
        const stats = { hot: 0, warm: 0, cold: 0, active: 0, superseded: 0, expired: 0 };
        for (const e of this.entries) {
            stats[tempOf(e, now)] += 1;
            const st = e.state ?? 'active';
            if (st === 'active' && e.expiresAt !== undefined && e.expiresAt < now)
                stats.expired += 1;
            else
                stats[st] += 1;
        }
        return stats;
    }
}
