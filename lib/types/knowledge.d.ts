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
export type EntryState = 'active' | 'superseded' | 'expired';
export type MemoryTemp = 'hot' | 'warm' | 'cold';
export interface KnowledgeEntry {
    id: string;
    type: 'skill' | 'fact' | 'preference' | 'event' | 'person' | 'procedure' | 'error';
    content: string;
    tags: string[];
    source: string;
    created: number;
    weight: number;
    hits: number;
    lastHitAt?: number;
    state?: EntryState;
    supersededBy?: string;
    expiresAt?: number;
    confidence?: number;
}
interface StoreItem {
    type: 'fact';
    content: string;
    tags: string[];
    source: string;
}
/** 确定性密钥脱敏器（engram 拆解）：API key/JWT/Bearer/key=value 形密钥 → <REDACTED:…>，写入前先于一切落盘。 */
export declare function redact(text: string): string;
/** 温度推导：热=24h 内命中/诞生；温=7 天内；冷=更老。 */
export declare function tempOf(e: KnowledgeEntry, now?: number): MemoryTemp;
/** 知识条目库：entries.json 持久化（去重），检索=关键词命中*3+权重*2+新近度+温度。 */
export declare class KnowledgeStore {
    private log;
    private entries;
    private readonly file;
    constructor(dshHome: string, workspace: string | null | undefined, log: (line: string) => void);
    load(): Promise<void>;
    private save;
    /** 去重入库（按 content 精确匹配），返回新增条数。写入一律先脱敏。 */
    addMany(items: readonly StoreItem[]): Promise<number>;
    /**
     * 温度生命周期检索：命中数*3 + 权重*2 + 温度加成 + 新近度。
     * active 全分；superseded 打 0.15 折沉底（engram：降级不删）；expired 直接排除；
     * 过期线 expiresAt 一过自动按 expired 处理（惰性标记）。
     */
    search(query: string, limit: number): KnowledgeEntry[];
    /** 压顶偏好：active 的 preference，按权重×新近排序（engram：管理员规则=每会话第一行）。 */
    preferences(limit: number): KnowledgeEntry[];
    /** 当前条目数。 */
    size(): number;
    /** 命中强化：权重 +1、热度刷新（读路径加热：cold→warm→hot 由 tempOf 自动体现）。 */
    reinforce(id: string): Promise<void>;
    /** supersede（engram 拆解）：旧真相降级不删，新条目占位。 */
    supersede(oldId: string, newId: string): Promise<boolean>;
    /** 过期：立即置 expired（留档可考古，默认不召回）。 */
    expire(id: string): Promise<boolean>;
    /**
     * P1 纠正/偏好句式捕获器（零LLM）：从管理员消息文本沉淀 preference 条目。
     * 返回新增条数；去重按"方向+内容"，同样的话只记一次，重复出现 weight+1。
     */
    captureFromMessage(text: string, source: string): Promise<number>;
    /** P4 失败→解法闭环：error 条目带 cmd:<命令> 标签，命令跑通时沉淀 procedure 并闭环旧 error。 */
    promoteProcedure(cmd: string, note: string, source: string): Promise<number>;
    /** 生命周期体检：各温度/状态计数（运维观测用）。 */
    lifecycleStats(): {
        hot: number;
        warm: number;
        cold: number;
        active: number;
        superseded: number;
        expired: number;
    };
}
export {};
