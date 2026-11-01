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
const MATRIX = {
    napcat: {
        set_self_longnick: true, set_qq_profile: true, set_qq_avatar: true,
        set_online_status: true, set_diy_online_status: true,
        send_group_sign: true, send_flash_msg: true,
        send_group_forward_msg: true, send_private_forward_msg: true,
        create_collection: true, get_group_honor_info: true, get_recent_contact: true,
        add_custom_face: true, fetch_ptt_text: true, get_ai_record: true,
        send_group_ai_record: true, get_ai_characters: true,
        set_input_status: true, set_msg_emoji_like: true, ocr_image: true,
    },
    snowluma: {
        set_self_longnick: true, set_qq_profile: true, set_qq_avatar: true,
        set_online_status: true, set_diy_online_status: true,
        send_group_sign: true, send_flash_msg: true,
        send_group_forward_msg: true, send_private_forward_msg: true,
        create_collection: true, get_group_honor_info: true, get_recent_contact: true,
        add_custom_face: true, fetch_ptt_text: true, get_ai_record: true,
        send_group_ai_record: true, get_ai_characters: true,
        set_input_status: true, set_msg_emoji_like: true, ocr_image: true,
        // SnowLuma 独有的加强面（catalog 实测 2026-10-31，212 action）：
        // qzone 公共动态全家桶（点赞/评论/跟评/转发/拉黑/粉丝）、收藏列表、
        // 闪照文件管理、单条转发、自定义表情管理（改描述/置顶/删除）、资料点赞。
        get_collection_list: true, get_profile_like: true, profile_like: true,
        get_flash_file_list: true, get_flash_file_url: true, delete_flash_file: true,
        rename_flash_file: true, create_flash_task: true,
        forward_friend_single_msg: true, forward_group_single_msg: true,
        get_qzone_feeds: true, get_qzone_msg_list: true, get_qzone_msg_detail: true,
        like_qzone: true, unlike_qzone: true, comment_qzone: true,
        get_group_signed_list: true,
    },
    lagrange: {
        // 幽灵（Lagrange.Core）全面支持：标准 v11 全量 + NTQQ 扩展大部分
        send_group_forward_msg: true, send_private_forward_msg: true,
        set_input_status: true, set_msg_emoji_like: true,
        set_self_longnick: true, set_qq_profile: true, set_qq_avatar: true,
        set_online_status: true, send_group_sign: true,
        get_group_honor_info: true, get_recent_contact: true,
        fetch_ptt_text: 'unknown', set_diy_online_status: 'unknown',
        send_flash_msg: 'unknown', create_collection: 'unknown', add_custom_face: 'unknown',
        get_ai_record: false, send_group_ai_record: false, get_ai_characters: false,
    },
    llonebot: {
        send_group_forward_msg: true, send_private_forward_msg: true,
        set_input_status: 'unknown', set_msg_emoji_like: 'unknown', fetch_ptt_text: 'unknown',
        set_self_longnick: 'unknown', set_qq_profile: 'unknown', set_qq_avatar: 'unknown',
        set_online_status: 'unknown', send_group_sign: 'unknown', send_flash_msg: 'unknown',
        create_collection: 'unknown', get_group_honor_info: 'unknown', get_recent_contact: 'unknown',
        add_custom_face: 'unknown', get_ai_record: 'unknown', send_group_ai_record: 'unknown', get_ai_characters: 'unknown',
    },
    'go-cqhttp': {
        send_group_forward_msg: true, send_private_forward_msg: true,
        set_qq_profile: true,
        set_self_longnick: false, set_qq_avatar: 'unknown', set_online_status: 'unknown',
        set_diy_online_status: false, send_group_sign: false, send_flash_msg: false,
        create_collection: false, get_group_honor_info: 'unknown', get_recent_contact: 'unknown',
        add_custom_face: 'unknown', fetch_ptt_text: false,
        get_ai_record: false, send_group_ai_record: false, get_ai_characters: false,
        set_input_status: false, set_msg_emoji_like: 'unknown', ocr_image: false,
    },
    unknown: {},
};
/** 从 get_version_info 的返回里认客户端品牌。 */
export function detectClient(info) {
    const appName = String(info?.app_name ?? '');
    const version = String(info?.app_version ?? info?.version ?? info?.protocol_version ?? '');
    const hay = `${appName} ${version}`.toLowerCase();
    let kind = 'unknown';
    if (hay.includes('napcat') || hay.includes('猫') || hay.includes('catclient'))
        kind = 'napcat';
    else if (hay.includes('snowluma'))
        kind = 'snowluma';
    else if (hay.includes('lagrange') || hay.includes('幽灵') || hay.includes('ghost'))
        kind = 'lagrange';
    else if (hay.includes('llonebot') || hay.includes('liteoader'))
        kind = 'llonebot';
    else if (hay.includes('go-cqhttp') || hay.includes('gocqhttp') || hay.includes('cqhttp'))
        kind = 'go-cqhttp';
    return { kind, version, appName: appName || kind };
}
export function capabilityMatrixOf(kind) {
    return { ...MATRIX[kind] };
}
export function capabilityOf(kind, action) {
    return MATRIX[kind]?.[action] ?? 'unknown';
}
/** 客户端展示信息（设置页/日志用） */
export function describeClient(id) {
    const c = {
        napcat: 'NapCat（扩展能力最全）',
        snowluma: 'SnowLuma（社区二改，部分扩展支持）',
        lagrange: 'Lagrange.Core（纯协议实现，扩展子集）',
        llonebot: 'LLOneBot（官方 QQ 内嵌，扩展子集）',
        'go-cqhttp': 'go-cqhttp 系（老牌，无 NTQQ 扩展）',
        unknown: '未知 OneBot 实现（按标准动作对待）',
    };
    return `${c[id.kind]}${id.version ? ` · ${id.version.slice(0, 40)}` : ''}`;
}
