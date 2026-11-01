/** QQ agent tools: thin OneBot v11 wrappers registered on the global tools registry.
 *
 * Subset ported from an earlier OneBot extension's manifest tools — the ones that
 * are pure protocol calls. Anything needing the old enhancement subsystems
 * (model-caller rotation, persona manager) is intentionally not ported.
 * Approval policy stays with the harness's permission presets.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QQChannelConfig } from './config.js';
import type { OneBotClient } from './onebot.js';
import type { EmojiLibrary } from './emoji-library.js';
import type { OutboundQueue } from './outbound.js';
import type { SentLog } from './sent-log.js';
import type { KnowledgeStore } from './knowledge.js';
export declare function isInnerMonologueLeak(text: string): boolean;
export declare function isPersonaSignatureLeak(text: string): boolean;
export declare function registerQQTools(ctx: Context, config: QQChannelConfig, client: OneBotClient, out: OutboundQueue, log: (line: string) => void, library?: EmojiLibrary, affection?: {
    book(delta: number, reason: string): Promise<unknown>;
    setStage(stage: string, event: string): Promise<{
        ok: boolean;
        note: string;
    }>;
    writeCustomHtml(html: string): Promise<void>;
}, sentLog?: SentLog, knowledge?: KnowledgeStore, sixDim?: {
    report(delta: Record<string, number>, note: string): Promise<void>;
}, dmGate?: {
    review(action: 'list' | 'approve' | 'deny', userId?: number): Promise<unknown>;
}): () => void;
