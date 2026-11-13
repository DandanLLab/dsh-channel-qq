/** QQ 频道控制台（web panel）后端。
 *
 * 结构：一张声明式路由表 + 每个域一个独立 status builder —— 以后加功能 =
 * 写一个 builder + 在 ROUTES 里加一行，前端在 PAGE 里加一张卡片。
 * 所有路由复用 settings-api 的回环守卫（Host header 校验，DNS-rebinding 安全），
 * 不返回任何密钥。
 *
 * GET  /qq-panel                 → 控制台页面（lib/qq-panel.html，构建时随 copy 步骤复制）
 * GET  /channel-qq-api/status    → 聚合实时状态（连接 / 会话窗口 / 陌生人门控 / 白名单）
 * GET  /channel-qq-api/log       → channel-qq.log 尾部（?lines=N，默认 120，上限 500）
 * POST /channel-qq-api/dm-gate   → {action:'approve'|'deny'|'list', userId?} 透传 DmGate.review
 * POST /channel-qq-api/reconnect → OneBotClient.forceReconnect()（重置退避并立即重拨）
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QQChannelConfig } from './config.js';
export interface PanelDeps {
    client?: {
        selfId: number | null;
        clientIdentity: import('./client-compat.js').ClientIdentity | null;
        connection: {
            mode: string;
            url: string;
        };
        isConnected?: () => boolean;
        forceReconnect?: () => void;
    } | null;
    bridge?: {
        snapshot(): Array<{
            key: string;
            isGroup: boolean;
            chatId: number;
            sessionId: string;
            live: boolean;
            pending: boolean;
            queued: number;
            lastEventTime: number | null;
        }>;
    } | null;
    dmGate?: {
        review(action: 'approve' | 'deny' | 'list', userId?: number): Promise<unknown>;
    } | null;
}
export declare function registerPanel(ctx: Context, config: QQChannelConfig, dshHome: string, log: (line: string) => void, deps: PanelDeps): () => void;
