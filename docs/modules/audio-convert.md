# audio-convert.ts — 音频转码 / TTS

**文件**: `src/audio-convert.ts`（511 行）

## 职责
双向音频管线：入站 silk→wav（STT 前置）；出站文字→语音（TTS 多 provider）→
silk（QQ 可播），ffmpeg 兜底转码。

## 关键机制
- silk-wasm：QQ 语音编解码（isSilk 探测/decode/encode）
- TTS provider 可插拔（config.audio.*）；语音文件魔数后缀校验（伪装后缀发不出动画）
- qq_send_voice / qq_can_send_voice 背后就是这里

## 模块连接
- **上游**: stt.ts（入站）、tools.ts（qq_send_voice 出站）
- **依赖**: ffmpeg（可选）、silk-wasm
