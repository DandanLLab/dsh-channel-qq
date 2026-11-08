import type { EmojiLibrary } from './emoji-library.js';
export interface ChainDeps {
    isGroup: boolean;
    /** 群号或好友 QQ 号 */
    target: number;
    log: (line: string) => void;
    client: {
        call(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    };
    /** meme pack 关键词匹配（tools.ts 的三级前两级） */
    memePackMatch(desc: string): string | null;
    library?: EmojiLibrary;
    /** 回应标记的目标消息（quote 路径=被引用消息；send 路径=可选 reactToId 参数） */
    reactMessageId?: number | null;
    /** meme pack / 语义兜底的部署常量（由 tools.ts 注入，单一权威源） */
    memePackDir: string;
    memePackDb: string;
    semanticKbCli: string;
    semanticKbWorkspace: string;
}
export interface ChainActionLog {
    tag: string;
    result: string;
    ok: boolean;
}
export interface ChainOutcome {
    /** 剥完标记、miss 标记按文字表情补回后的剩余正文 */
    text: string;
    stickersSent: number;
    actions: ChainActionLog[];
}
/**
 * 1109 漏后括号容错（师父令）：模型偶尔漏写标记的后括号（`[表情: 猫猫敬礼` 直接收尾），
 * 原 tagRe 要求闭合 `]`，漏括号时整个标记不匹配 → 原文带 `[表情:` 直漏 QQ。
 * 扫描前补齐：开标记到下一个 `[` 或字符串尾之间没有 `]`（也没有全角 `］`），
 * 就在第一个换行处（如有）或段尾补 `]`。已闭合的标记原样不动。
 */
export declare function balanceTagBrackets(s: string): string;
export declare function runMessageChain(rawText: string, deps: ChainDeps): Promise<ChainOutcome>;
