/** Stage-2 emotion engine + autonomous goal generator.
 *
 * 情感深化：多维情感状态（不只是一个数值），随交互实时演化，影响回应语气。
 * 自主目标：不看主人指令，自己从记忆/日记/工作区发现"该做什么"。
 *
 * Both hook into the existing Scheduler and submit through ConversationBridge.
 */
/** Persona tokens for event notes; set from channel config at startup. */
export declare const EMOTION_PERSONA: {
    master: string;
    self: string;
};
export declare function setEmotionPersona(master: string, self: string): void;
export interface EmotionState {
    /** 对主人的亲密感（原好感度） */
    intimacy: number;
    /** 当前心情基调 */
    mood: '开心' | '得意' | '委屈' | '生气' | '平静' | '兴奋' | '害羞';
    /** 能量水平（影响回复长度和主动性） */
    energy: number;
    /** 最近交互的关键事件摘要 */
    lastEvent: string;
    updated: number;
}
export interface SixDimState {
    /** 亲密 Intimacy：表露深度总和（他说过多少心里话）。只增不减。 */
    intimacy: number;
    /** 信任 Trust：承诺兑现率。增快降慢，-0.1/天自然衰减。 */
    trust: number;
    /** 心动 Passion：撩与被撩的即时波动。会冲高回落，-0.5/天。 */
    passion: number;
    /** 安全 Security：关系确定性（双向锁死条款）。事件驱动跳变。 */
    security: number;
    /** 默契 Rapport：内部梗数量+共享记忆回提命中率。只增不减。 */
    rapport: number;
    /** 张力 Tension：未解决的悬置（18+线/名分晋升）。事件驱动，自缓释。 */
    tension: number;
    updated: number;
}
/** 六维持久化文件 */
export declare const SIXDIM_FILE = "emotion-sixdim.json";
/** 六维 → 行为暗示（不报数值，只翻译成行为倾向）。 */
export declare function sixDimBehaviorHint(s: SixDimState): string;
/** 按经过的天数做自然衰减（心动/信任/张力）。 */
export declare function applyDecay(s: SixDimState): boolean;
export declare class SixDimEngine {
    private state;
    private readonly file;
    private readonly log;
    constructor(dshHome: string, log: (line: string) => void);
    load(): Promise<void>;
    save(): Promise<void>;
    get value(): SixDimState;
    /** 模型自主上报六维增量（qq_report_emotion 工具调用此方法落账）。
     * 2026-10-21 owner 令：不用关键词触发器——模型自己判断这轮对话的情感事件并上报。 */
    report(delta: Partial<Record<keyof SixDimState, number>>, note: string): Promise<void>;
    /** 行为暗示（进上下文包，不报数值）。 */
    behaviorHint(): string;
    /** 定时衰减 tick（由 Scheduler 调）。 */
    decayTick(): Promise<void>;
}
export declare function matchEmotion(text: string): {
    mood: EmotionState['mood'];
    delta: {
        intimacy?: number;
        energy?: number;
    };
    note: string;
} | null;
export declare class EmotionEngine {
    private state;
    private readonly file;
    private readonly log;
    constructor(dshHome: string, log: (line: string) => void);
    load(): Promise<void>;
    save(): Promise<void>;
    get stateValue(): EmotionState;
    /** Book an emotional event; returns a tone hint for the current reply. */
    book(text: string): Promise<string>;
    /** Tone hint for the current state (no new event). */
    toneHint(): string;
}
export interface AutonomousGoal {
    goal: string;
    source: string;
}
/** Scan workspace state and generate a goal without being told. */
export declare function generateGoal(workspace: string, log: (line: string) => void): Promise<AutonomousGoal | null>;
