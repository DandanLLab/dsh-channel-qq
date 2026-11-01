/** OneBot 客户端（协议端）探测与能力矩阵。
 *
 * OneBot v11 标准动作所有客户端通吃；扩展动作（签名/闪照/AI 语音/打卡…）各家实现
 * 不一。这里在连接建立时用 `get_version_info` 探测一次客户端品牌，之后工具层按
 * 能力矩阵给模型**提前说明**（而不是让调用失败才发现），并把"不支持"的报错翻译
 * 成可读的提示。
 *
 * 支持的客户端：
 *   napcat    — NapCat（扩展 action 最全，签名/闪照/合并转发/AI 语音/打卡全支持）
 *   lagrange  — Lagrange.Core（纯协议实现；标准动作全，扩展子集）
 *   llonebot  — LLOneBot（官方 QQ 内嵌；扩展子集，持续跟进）
 *   snowluma  — SnowLuma（二改社区客户端；NapCat 同名扩展大部分支持）
 *   go-cqhttp — go-cqhttp 系（老牌；无 NTQQ 扩展）
 *   unknown   — 探测失败/其他实现（按标准动作对待，扩展动作调用时优雅降级）
 */
export type ClientKind = 'napcat' | 'lagrange' | 'llonebot' | 'snowluma' | 'go-cqhttp' | 'unknown';
export interface ClientIdentity {
    kind: ClientKind;
    /** 客户端自报版本串（原文） */
    version: string;
    /** 展示名 */
    appName: string;
}
/** 扩展动作 → 支持矩阵（true=支持 / false=明确不支持 / 'unknown'=未验证，调用试试） */
export type Capability = boolean | 'unknown';
/** 从 get_version_info 的返回里认客户端品牌。 */
export declare function detectClient(info: {
    app_name?: string;
    app_version?: string;
    version?: string;
    protocol_version?: string;
} | null | undefined): ClientIdentity;
export declare function capabilityMatrixOf(kind: ClientKind): Record<string, Capability>;
export declare function capabilityOf(kind: ClientKind, action: string): Capability;
/** 客户端展示信息（设置页/日志用） */
export declare function describeClient(id: ClientIdentity): string;
