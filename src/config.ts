/** Channel configuration. One row, one account. Values live in the profile's user patch layer. */

export interface ConnectionConfig {
  /** forward = the plugin dials NapCat's WS server; reverse = the plugin hosts a WS server NapCat dials into. */
  mode: 'forward' | 'reverse'
  /** forward: NapCat WS URL. reverse: listen URL, e.g. ws://127.0.0.1:8082 (port is the bind port). */
  url: string
}

export interface SegmentationConfig {
  enabled: boolean
  /** natural = 跟句号走; conservative = 太短的相邻句合并; active = 每句一条. */
  style: 'natural' | 'conservative' | 'active'
  /** Only gates texts with NO sentence enders; 句号说了算 otherwise. */
  minLength: number
  maxSegments: number
  removeTrailingPeriod: boolean
}

export interface PokeConfig {
  enabled: boolean
  /** Pokes within the window before 我 reacts (the patience). */
  patience: number
  windowSec: number
  /** Poke the sender back when patience runs out. */
  pokeBack: boolean
}

export interface ImageConfig {
  /** Download inbound images and attach them to the model prompt (vision). */
  enabled: boolean
  /** Max images attached per message (extras stay noted as [图片]). */
  maxPerMessage: number
}

export interface GroupModelConfig {
  /** Group conversations run on this route; null = same as the default route. */
  provider: string | null
  model: string | null
}

export interface STTConfig {
  enabled: boolean
  /** OpenAI-compatible /audio/transcriptions base, e.g. https://host/v1 */
  baseUrl: string | null
  /** API key (plain, or $ENV to read from environment). */
  apiKey: string | null
  model: string
}

export interface BatchingConfig {
  /** Quiet-window: analyze the intake queue this long after the last message. */
  windowMs: number
  /** Flush early once this many lines accumulated. */
  maxMessages: number
  /** Flush early once this many characters accumulated. */
  maxChars: number
}

export interface InjectModeConfig {
  /** Bypass batching: every group message is injected into the agent context as it arrives. */
  enabled: boolean
  /** When the agent is idle, deliver immediately and wake it (steer) instead of parking it (inject). */
  wakeIdle: boolean
}

export interface EmojiConfig {
  /** Steal sticker images seen in the primary group into `dir`. */
  steal: boolean
  /** With `autoSendProbability`, attach a random registered sticker after a reply. */
  autoSend: boolean
  autoSendProbability: number
  /** Stolen/raw sticker directory (defaults to <dshHome>/channel-qq/emoji). */
  dir: string | null
  /** Registered sticker directory (defaults to <dshHome>/channel-qq/emoji-registered). */
  registeredDir: string | null
}

export interface KeywordReaction {
  keywords: string[]
  reaction: string
}

export interface PersonaConfig {
  /** The bot's persona name (how it calls itself in logs/UI, e.g. 我). */
  selfName: string
  /** How the bot addresses its master (e.g. 主人). */
  masterName: string
  /** How the bot addresses other group members (e.g. 朋友). */
  peerName: string
  /** The bot's self-pronoun in speech (e.g. 咱). */
  pronoun: string
}

export interface QQChannelConfig {
  connection: ConnectionConfig
  accessToken?: string
  /** The bot's own QQ number, from NapCat lifecycle events or configured explicitly. */
  selfId: number
  /** QQ numbers allowed to use admin-flavoured tools. */
  admins: number[]
  /** Master switch for group-chat handling (DMs unaffected). */
  /** Loopback port of the master-only affection dashboard; 0 disables. */
  affectionPort: number
  groupEnabled: boolean
  /** The core group; talkValue/emoji/steal semantics key off it. */
  primaryGroup: number | null
  /** 游历群/外出群白名单：可发言但非主群（2026-09-30 owner 令） */
  extraGroups?: number[]
  requireMention: boolean
  /** Base reply probability in groups; the primary group may override via primaryTalkValue. */
  talkValue: number
  primaryTalkValue?: number
  /** Workspace the QQ agents run in (main knowledge workspace). */
  workspacePath: string | null
  agentPreset: string
  permissionPreset: string
  rateLimitMs: number
  maxMessageLength: number
  segmentation: SegmentationConfig
  batching: BatchingConfig
  injectMode: InjectModeConfig
  imageRecognition: ImageConfig
  poke: PokeConfig
  stt: STTConfig
  groupModel: GroupModelConfig
  /** Additional group-level or user-level name triggers. */
  keywordTriggers: string[]
  keywordReactions: KeywordReaction[]
  emoji: EmojiConfig
  persona: PersonaConfig
  /** Bundled life-engine component (memory plasticity / inner monologue / sleep consolidation / KB search). */
  lifeEngine: LifeEngineComponentConfig
  /** Bundled dsh-meme component (meme pack library / send_meme / learn_meme / admin panel). */
  memeEngine: MemeEngineComponentConfig
  /** 陌生人私聊门控：非 admins 私聊需白名单或主人审计放行。 */
  dmGate: DmGateConfig
  /** Optional external RSS feeder argv; the 2h slot idles when unset. */
  rssPull?: { command: string[] }
  debug: boolean
}

export interface MemeEngineComponentConfig {
  /** Master switch for the bundled meme component; default true. */
  enabled: boolean
  /** Optional meme pack root override; null = bundled pack + ~/.dsh/meme-packs scan. */
  memeRoot: string | null
  /** Admin panel + /dsh-memes image routes (needs host webServer). */
  webRoutes: boolean
}

/** 陌生人私聊门控：非 admins 的私聊先过这道闸。 */
export interface DmGateConfig {
  /** Master switch; default true（admins 永远直通，不受此开关影响）. */
  enabled: boolean
  /** 允许直通的额外 QQ 号（好友试运行名单）。 */
  allowList: number[]
  /** 门控模式下，陌生人首次私聊是否给主人发待审通知。 */
  notifyAdmin: boolean
  /** 待审通过前的统一回复文案。 */
  pendingReply: string
}

export interface LifeEngineComponentConfig {
  /** Master switch for the bundled life-engine component; default true. */
  enabled: boolean
}

export const DEFAULT_CONFIG: QQChannelConfig = {
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
}

/** Deep-merge a partial patch (from the cordis row config) over the defaults. */
export function resolveConfig(patch: Partial<QQChannelConfig> | undefined): QQChannelConfig {
  const raw = { ...DEFAULT_CONFIG, ...(patch ?? {}) } as QQChannelConfig
  raw.connection = { ...DEFAULT_CONFIG.connection, ...(patch?.connection ?? {}) }
  raw.segmentation = { ...DEFAULT_CONFIG.segmentation, ...(patch?.segmentation ?? {}) } as SegmentationConfig
  raw.batching = { ...DEFAULT_CONFIG.batching, ...(patch?.batching ?? {}) }
  raw.injectMode = { ...DEFAULT_CONFIG.injectMode, ...(patch?.injectMode ?? {}) }
  raw.imageRecognition = { ...DEFAULT_CONFIG.imageRecognition, ...(patch?.imageRecognition ?? {}) }
  raw.poke = { ...DEFAULT_CONFIG.poke, ...(patch?.poke ?? {}) }
  raw.groupEnabled = patch?.groupEnabled ?? true
  raw.stt = { ...DEFAULT_CONFIG.stt, ...(patch?.stt ?? {}) }
  raw.groupModel = { ...DEFAULT_CONFIG.groupModel, ...(patch?.groupModel ?? {}) }
  raw.emoji = { ...DEFAULT_CONFIG.emoji, ...(patch?.emoji ?? {}) }
  raw.persona = { ...DEFAULT_CONFIG.persona, ...(patch?.persona ?? {}) }
  raw.lifeEngine = { ...DEFAULT_CONFIG.lifeEngine, ...(patch?.lifeEngine ?? {}) }
  raw.memeEngine = { ...DEFAULT_CONFIG.memeEngine, ...(patch?.memeEngine ?? {}) }
  raw.dmGate = { ...DEFAULT_CONFIG.dmGate, ...(patch?.dmGate ?? {}) }
  return raw
}
