import type { QQChannelConfig } from './config.js';
import type { OneBotClient } from './onebot.js';
/**
 * Hard-split one overlong segment at natural boundaries (ported from the
 * extension's smartSplitMessage): newline first, then sentence punctuation,
 * then a hard cut. Keeps every chunk under the OneBot-safe limit.
 */
export declare function smartSplitMessage(text: string, limit: number): string[];
export declare function segmentReply(text: string, config: QQChannelConfig): string[];
/** Serialises sends so the configured rate limit holds across segments and tools. */
export declare class OutboundQueue {
    private readonly client;
    private readonly config;
    private readonly log;
    private chain;
    /** Every segment ever sent, keyed lowercase — a repeat is skipped (sentMessages). */
    private readonly sentHistory;
    constructor(client: OneBotClient, config: QQChannelConfig, log: (line: string) => void);
    private readonly typingTimers;
    private readonly typingCaps;
    private readonly pendingDir;
    private pendingRedrive;
    private persistPending;
    private startPendingRedrive;
    /** Queue one send; trailing nullish segments are skipped silently.
     * 2026-10-20 owner 令：没发出去的延时补发，确保全文完整——失败重试 1+3 次（退避 2/5/10s），
     * 重试耗尽仍失败的全文写入 dead letter 留档，绝不静默丢失。 */
    enqueue(send: () => Promise<unknown>, describe?: () => string, onGiveUp?: () => {
        action: string;
        payload: Record<string, unknown>;
    }): void;
    private sendWithRetry;
    private deadLetter;
    /** 思考期"正在输入"循环（owner 令：要能看到bot在打字）：私聊回合开始刷起，
     *  5s 一拍续命（QQ 输入态几秒就过期），发送完成自动停，10 分钟硬上限防失控。 */
    startTyping(chatId: number): void;
    stopTyping(chatId: number): void;
    sendSegments(params: {
        isGroup: boolean;
        chatId: number;
        replyTo: number | null;
        text: string;
    }): void;
    sendNow(action: string, payload: Record<string, unknown>): Promise<unknown>;
    /** Rate-limited send that resolves with the OneBot result when its turn in the chain comes. */
    push<T>(task: () => Promise<T>): Promise<T>;
}
