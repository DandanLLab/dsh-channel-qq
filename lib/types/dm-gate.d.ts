/** 陌生人私聊门控（主人审计白名单）。
 *
 * 非 admins 的私聊默认不进 agent：先查 QQ 好友列表，好友直通；
 * 非好友进待审名单（持久化 <dshHome>/channel-qq/dm-gate.json），
 * 给陌生人回统一文案、给主人发一条待审通知。
 * 主人用 `qq_dm_gate` 工具（action=approve/deny/list）或把对方号
 * 加进 `dmGate.allowList` 放行；被拒的号进冷却（再发不通知不回复）。
 */
import type { OneBotClient } from './onebot.js';
import type { DmGateConfig } from './config.js';
export declare class DmGate {
    private readonly config;
    private readonly admins;
    private readonly client;
    private readonly log;
    private state;
    private loaded;
    private readonly file;
    constructor(dshHome: string, config: DmGateConfig, admins: number[], client: () => OneBotClient | null, log: (line: string) => void);
    load(): Promise<void>;
    private save;
    /** 好友列表（带 30s 缓存；查不到按 null=不判断，保守放行走 pending 流程） */
    private friendsCache;
    private friendIds;
    /** 判定：true=放行进 agent；false=已拦截（回复/通知已发出）。 */
    admit(userId: number, nickname: string): Promise<boolean>;
    private notifiedAt;
    private notifyAdmin;
    /** 通用预警：给主人发一条安全通知（限频：同 key 10 分钟一次，全局 60 秒连发保护）。 */
    private alertSeen;
    alert(text: string, dedupeKey: string): Promise<void>;
    /** 主人审计操作。 */
    review(action: 'approve' | 'deny' | 'list', userId?: number): Promise<unknown>;
}
