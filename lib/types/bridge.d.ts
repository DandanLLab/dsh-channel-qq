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
import type { KnowledgeStore } from './knowledge.js';
import type { Context } from '@deepseek-ai/cordis';
import type { QQChannelConfig } from './config.js';
import { OutboundQueue } from './outbound.js';
import type { OneBotClient } from './onebot.js';
import type { OneBotEvent } from './types.js';
export interface ReplyListener {
    (isGroup: boolean, chatId: number): void;
}
export declare class ConversationBridge {
    private readonly ctx;
    private readonly config;
    private readonly client;
    private readonly out;
    private readonly log;
    private get persona();
    private readonly conversations;
    private readonly ensureInFlight;
    /** Poke patience counters per group. */
    private readonly pokes;
    /** Per-conversation outbound message logs (quote-chain memory). */
    private readonly sentLogs;
    /** Multi-dimensional emotional state (stage-2 情感深化). */
    emotionEngine: {
        book(text: string): Promise<string>;
        toneHint(): string;
    } | null;
    /** 六维情感账本（亲密/信任/心动/安全/默契/张力），模型自主上报、出站行为暗示。 */
    sixDimEngine: {
        report(delta: Record<string, number>, note: string): Promise<void>;
        behaviorHint(): string;
    } | null;
    /** Stage-2 knowledge store: top relevant entries ride with each packet. */
    knowledge: KnowledgeStore | null;
    /** 陌生人私聊门控（dmGate.enabled 时非 admins 私聊先过审）。 */
    dmGate: {
        admit(userId: number, nickname: string): Promise<boolean>;
        alert(text: string, dedupeKey: string): Promise<void>;
    } | null;
    private workspace;
    /** Fired whenever a reply turn is submitted (auto-emoji hook). */
    onReply: ReplyListener | null;
    constructor(ctx: Context, config: QQChannelConfig, client: OneBotClient, out: OutboundQueue, log: (line: string) => void);
    /** Stage-2 auto-retrieval v2（1101 温度生命周期改造）：偏好压顶 + 预算压缩 + 温度排序。 */
    private memoryHint;
    /** Stage-2 auto-retrieval: most relevant knowledge entries for this packet text. */
    private knowledgeHint;
    /**
     * 群聊包检索前置（2026-10-06 科技树点亮）：组包前先用 kb 本地向量检索捞历史相关话题,
     * 与关键词命中合并。同步关键词为主路,向量 presearch 为前置路;2 秒超时永不阻塞组包。
     */
    private knowledgeHintPre;
    /**
     * Self-heal workspace membership: every persisted qq-* session is re-attached
     * to the configured workspace at startup, so sessions created before an
     * attach persisted (or dropped by a crash) still group under the workspace.
     */
    reattachPersistedSessions(): Promise<void>;
    /** Release batch timers when the plugin unloads. */
    dispose(): void;
    /** STT one voice-bar message; failures are logged, never fatal. */
    private transcribeVoice;
    /** Proactive DM: she comes to find the master on her own initiative. */
    dmProactive(prompt: string): Promise<void>;
    /** Scheduler hooks: patrol / dream / evolution packets on the group session. */
    patrolTick(key: string, prompt: string): Promise<void>;
    dreamTick(key: string, prompt: string): Promise<void>;
    evolveTick(key: string, prompt: string): Promise<void>;
    private scheduledTick;
    /** Download inbound files into the workspace inbox so the agent can process them. */
    private receiveFiles;
    /** Group pokes with a patience counter — no instant reaction. */
    handleNotice(event: OneBotEvent): Promise<void>;
    /** Deterministic call: @-mention or keyword hit (DMs are always direct). */
    private isCalled;
    private talkChance;
    reactionHint(event: OneBotEvent): string | null;
    /** One message line for the intake packet. */
    private formatLine;
    handleEvent(event: OneBotEvent): Promise<void>;
    /** Arm (or re-arm) the quiet-window timer for one batched analysis. */
    private scheduleBatch;
    /** Deliver one group message straight into the agent context (inject mode). */
    private injectNow;
    /**
     * Analyze the intake queue as one packet.
     * `immediate` (a call) skips both the wait and the probability gate; a
     * running turn is not interrupted. A batch waits for idle instead of
     * queueing behind the running turn — that is the queueing we are avoiding.
     */
    private flushNow;
    private createConversationRecord;
    private ensureConversation;
    private ensureConversationInner;
    /** Master-only admin prompt: submit one packet into the master's DM session. */
    adminPrompt(prompt: string): Promise<void>;
    private sentLogFor;
    private ensureWorkspace;
    private submit;
}
