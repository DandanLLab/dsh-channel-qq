/** Channel configuration. One row, one account. Values live in the profile's user patch layer. */
export const DEFAULT_CONFIG = {
    connection: { mode: 'forward', url: 'ws://127.0.0.1:3001' },
    selfId: 10000,
    admins: [],
    primaryGroup: null,
    groupEnabled: true,
    affectionPort: 8789,
    requireMention: true,
    talkValue: 0.6,
    rateLimitMs: 800,
    maxMessageLength: 4000,
    segmentation: { enabled: true, style: 'natural', minLength: 20, maxSegments: 8, removeTrailingPeriod: true },
    batching: { windowMs: 20_000, maxMessages: 20, maxChars: 4000 },
    injectMode: { enabled: false, wakeIdle: true },
    imageRecognition: { enabled: true, maxPerMessage: 2 },
    poke: { enabled: true, patience: 3, windowSec: 300, pokeBack: true },
    stt: { enabled: true, baseUrl: null, apiKey: null, model: 'whisper-1' },
    groupModel: { provider: null, model: null },
    keywordTriggers: [],
    keywordReactions: [],
    workspacePath: null,
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    emoji: {
        steal: true,
        autoSend: false,
        autoSendProbability: 0.3,
        dir: null,
        registeredDir: null,
    },
    persona: { selfName: 'Assistant', masterName: 'Boss', peerName: 'Friend', pronoun: 'I' },
    lifeEngine: { enabled: true },
    memeEngine: { enabled: true, memeRoot: null, webRoutes: true },
    dmGate: {
        enabled: true,
        allowList: [],
        notifyAdmin: true,
        pendingReply: '你好呀，这是一台私人助手，不接陌生人会话。如果你认识主人，请让他加我好友或告知我放行～',
    },
    debug: false,
};
/** Deep-merge a partial patch (from the cordis row config) over the defaults. */
export function resolveConfig(patch) {
    const raw = { ...DEFAULT_CONFIG, ...(patch ?? {}) };
    raw.connection = { ...DEFAULT_CONFIG.connection, ...(patch?.connection ?? {}) };
    raw.segmentation = { ...DEFAULT_CONFIG.segmentation, ...(patch?.segmentation ?? {}) };
    raw.batching = { ...DEFAULT_CONFIG.batching, ...(patch?.batching ?? {}) };
    raw.injectMode = { ...DEFAULT_CONFIG.injectMode, ...(patch?.injectMode ?? {}) };
    raw.imageRecognition = { ...DEFAULT_CONFIG.imageRecognition, ...(patch?.imageRecognition ?? {}) };
    raw.poke = { ...DEFAULT_CONFIG.poke, ...(patch?.poke ?? {}) };
    raw.groupEnabled = patch?.groupEnabled ?? true;
    raw.stt = { ...DEFAULT_CONFIG.stt, ...(patch?.stt ?? {}) };
    raw.groupModel = { ...DEFAULT_CONFIG.groupModel, ...(patch?.groupModel ?? {}) };
    raw.emoji = { ...DEFAULT_CONFIG.emoji, ...(patch?.emoji ?? {}) };
    raw.persona = { ...DEFAULT_CONFIG.persona, ...(patch?.persona ?? {}) };
    raw.lifeEngine = { ...DEFAULT_CONFIG.lifeEngine, ...(patch?.lifeEngine ?? {}) };
    raw.memeEngine = { ...DEFAULT_CONFIG.memeEngine, ...(patch?.memeEngine ?? {}) };
    raw.dmGate = { ...DEFAULT_CONFIG.dmGate, ...(patch?.dmGate ?? {}) };
    return raw;
}
