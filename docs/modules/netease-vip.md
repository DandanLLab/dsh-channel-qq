# netease-vip.ts — 网易云音乐

**文件**: `src/netease-vip.ts`（173 行）

## 职责
网易云搜索/歌曲详情/直链/VIP 扫码登录，Cookie 持久化。

## 关键机制
- 免登录：搜索+免费歌直链；VIP 歌需扫码（qrLoginStart 拿二维码 → App 扫 → qrLoginPoll）
- Cookie：`<dshHome>/channel-qq/netease-cookie.txt` 持久化，登录一次长期有效
- 输出形态：qq_send_music_voice（语音条）/ qq_send_music_card（音乐卡）

## 模块连接
- **上游**: tools.ts（8 个 qq_netease*/music* 工具）
- **下游**: outbound.ts（发送）/ audio-convert.ts（歌曲转语音条）
