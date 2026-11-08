<div align="center">

🎙️ **stt** ｜ [← settings-api](./settings-api.md) ｜ [📚 总索引](./README.md) ｜ [audio-convert →](./audio-convert.md)

</div>

---

# stt.ts — 语音转文字

**文件**: `src/stt.ts`（123 行）

## 职责
语音条（ptt）→ 文字：QQ 语音是 silk 编码，先转 wav 再打 STT 端点（whisper 兼容），
转写结果以 `[语音条说：…]` 进上下文。

## 关键机制
- silk → wav：audio-convert.ts 的 convertSilkToWav（silk-wasm）
- 端点：config.stt.baseUrl + model（默认 whisper-1），未配 baseUrl 则跳过转写
- qq_fetch_ptt_text 工具：Agent 主动转写指定语音

## 模块连接
- **上游**: bridge.ts（record 段触发）、tools.ts（fetch_ptt_text）
- **依赖**: audio-convert.ts、onebot.ts（取语音文件）
