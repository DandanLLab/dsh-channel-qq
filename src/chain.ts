/** Outbound chain-action layer (2026-11-07 owner 令：连锁动作层).
 *
 * 一条消息的 text 里可以内联动作标记，按出现顺序逐个执行，剩余文字照常走分段发送。
 * 标记全部可选、可复用、可混排；执行器失败只记日志跳过，绝不阻塞后续动作和正文。
 *
 *   [表情: 描述]        发表情包（meme pack 关键词 → 收藏库 → pack 兜底 → 语义兜底；
 *                       四级全落空时标记按文字表情留在正文，绝不发空消息）
 *   [戳一戳]            私聊戳对方；群聊要带 QQ 号：[戳一戳: 123456]
 *   [点赞] / [点赞: 次数] 给对方资料点赞 1-10 次（仅私聊）
 *   [回应: emoji]       给一条消息贴表情回应（qq_reply_quote=被引用那条；qq_send_text 需带 reactToId）
 *
 * 设计约束（1107 空消息案教训）：表情 HIT 只发图；正文剥完标记后为空时由调用方决定
 * 不补发空文本（NapCat 不拦空消息，QQ 客户端只能渲染成"该消息不支持显示"）。
 */
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

import type { EmojiLibrary } from './emoji-library.js'

export interface ChainDeps {
  isGroup: boolean
  /** 群号或好友 QQ 号 */
  target: number
  log: (line: string) => void
  client: { call(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> }
  /** meme pack 关键词匹配（tools.ts 的三级前两级） */
  memePackMatch(desc: string): string | null
  library?: EmojiLibrary
  /** 回应标记的目标消息（quote 路径=被引用消息；send 路径=可选 reactToId 参数） */
  reactMessageId?: number | null
  /** meme pack / 语义兜底的部署常量（由 tools.ts 注入，单一权威源） */
  memePackDir: string
  memePackDb: string
  semanticKbCli: string
  semanticKbWorkspace: string
}

export interface ChainActionLog {
  tag: string
  result: string
  ok: boolean
}

export interface ChainOutcome {
  /** 剥完标记、miss 标记按文字表情补回后的剩余正文 */
  text: string
  stickersSent: number
  actions: ChainActionLog[]
}

/** 发送前按文件魔数校验后缀：伪装错就复制一份带真实后缀的临时文件再发（原图字节零修改）。 */
async function realExtPath(sendPath: string): Promise<string> {
  try {
    const buf = await fsPromises.readFile(sendPath)
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50
    const isGif = buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46
    const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8
    const ext = isPng ? '.png' : isGif ? '.gif' : isJpg ? '.jpg' : null
    if (ext !== null && !sendPath.toLowerCase().endsWith(ext)) {
      const tmpPath = sendPath.replace(/\.[^.]+$/, '') + '_send' + ext
      await fsPromises.writeFile(tmpPath, buf)
      setTimeout(() => { fsPromises.unlink(tmpPath).catch(() => {}) }, 30_000)
      return tmpPath
    }
  } catch { /* 读不了就按原路径发 */ }
  return sendPath
}

/** 1029 owner 令：词法 MISS 先走 meme pack 关键词直搜（词全命中→bigram 兜底）。 */
function memeKeywordFallback(deps: ChainDeps, desc: string, minScore = 3): string | null {
  try {
    const db = new DatabaseSync(deps.memePackDb, { readOnly: true })
    const rows = db.prepare('SELECT path, caption, keywords FROM memes').all() as Array<{ path: string; caption: string; keywords: string }>
    const stop = new Set(['一个', '这种', '这个', '就是', '已经', '可以', '还有', '还是', '那个', '什么', '怎么', '这样', '那样', '自己', '他们', '我们', '你们', '表情', '图片', '想要', '想看'])
    const toks: string[] = []
    for (const seg of desc.toLowerCase().split(/[\s，。、！？,.!?/|]+/)) {
      const w = seg.trim()
      if (w.length >= 2 && !stop.has(w)) toks.push(w)
      for (let i = 0; i + 2 <= w.length; i++) { const bi = w.slice(i, i + 2); if (!stop.has(bi)) toks.push(bi) }
    }
    let best: { path: string; score: number } | null = null
    for (const r of rows) {
      const hay = String(r.caption || '') + ' ' + String(r.keywords || '') + ' ' + String(r.path || '')
      let sc = 0
      for (const w of toks) if (hay.includes(w)) sc += (w.length >= 2 ? 2 : 1)
      if (!best || sc > best.score) best = { path: r.path, score: sc }
    }
    db.close()
    if (best && best.score >= minScore) {
      deps.log(`chain emoji keyword fallback: [${desc}] → ${best.path} (score ${best.score})`)
      return deps.memePackDir + '/' + best.path
    }
  } catch { /* pack 缺库时静默走语义 */ }
  return null
}

/** 语义兜底：kb brain 向量搜最贴的一张；找不到返回 null（miss 落字）。 */
async function memeSemanticFallback(deps: ChainDeps, desc: string): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const result: string = await new Promise((resolve) => {
    try {
      execFile(process.execPath, [deps.semanticKbCli, 'brain', '表情包 ' + desc], { timeout: 12_000, windowsHide: true, maxBuffer: 2 << 20, env: { ...process.env, KB_WORKSPACE: deps.semanticKbWorkspace } }, (er, so) => resolve(er && !so ? '' : String(so)))
    } catch { resolve('') }
  })
  const hit = result.match(/"file":"([^"]+\.(?:png|gif|jpg|jpeg))"/i)
  if (hit && fs.existsSync(hit[1]!.replace(/\\/g, '/'))) {
    deps.log(`chain emoji semantic fallback: [${desc}] → ${hit[1]}`)
    return hit[1]!.replace(/\\/g, '/')
  }
  return null
}

/** 表情执行器：四级匹配，HIT 发真图，全落空返回 null（由调用方落字）。 */
async function runSticker(deps: ChainDeps, desc: string): Promise<boolean> {
  let sendPath = deps.memePackMatch(desc) ?? ''
  if (!sendPath) {
    const hits = deps.library ? deps.library.search(desc, 1) : []
    if (hits.length > 0) sendPath = hits[0]!.file
  }
  if (!sendPath) sendPath = memeKeywordFallback(deps, desc) ?? ''
  // 1107 近失援救（猫猫贴贴抱抱案：正确 gif 只差一分）：阈值降到 1 取最优行——
  // 有一分相似就发最像的真图，绝不把带方括号的文字表情漏给 QQ（客户端永远不会把贴纸退化成文字）
  if (!sendPath) sendPath = memeKeywordFallback(deps, desc, 1) ?? ''
  if (!sendPath) sendPath = (await memeSemanticFallback(deps, desc)) ?? ''
  if (!sendPath && lastHitSticker) { sendPath = lastHitSticker; deps.log(`chain emoji default fallback (lastHit): [${desc}] → ${sendPath}`) }
  if (!sendPath) return false
  sendPath = await realExtPath(sendPath)
  const b64 = (await fsPromises.readFile(sendPath)).toString('base64')
  const imgMsg = [{ type: 'image', data: { file: `base64://${b64}` } }]
  const payload = deps.isGroup ? { group_id: deps.target, message: imgMsg } : { user_id: deps.target, message: imgMsg }
  await deps.client.call(deps.isGroup ? 'send_group_msg' : 'send_private_msg', payload)
  lastHitSticker = sendPath
  deps.log(`chain emoji HIT: [${desc}] → ${sendPath}`)
  return true
}

let lastHitSticker = ''

export async function runMessageChain(rawText: string, deps: ChainDeps): Promise<ChainOutcome> {
  const actions: ChainActionLog[] = []
  let stickersSent = 0
  const missTexts: string[] = []

  // 单趟扫描：四类标记按出现顺序执行（同名标记可重复）
  const tagRe = /\[(表情|戳一戳|点赞|回应)[:：]?\s*([^\]]*)\]/g
  const pieces: Array<{ kind: 'text' | 'tag'; body: string; arg?: string }> = []
  let cursor = 0
  for (const m of rawText.matchAll(tagRe)) {
    const idx = m.index ?? 0
    if (idx > cursor) pieces.push({ kind: 'text', body: rawText.slice(cursor, idx) })
    pieces.push({ kind: 'tag', body: m[1]!, arg: (m[2] ?? '').trim() })
    cursor = idx + m[0].length
  }
  if (cursor < rawText.length) pieces.push({ kind: 'text', body: rawText.slice(cursor) })

  for (const piece of pieces) {
    if (piece.kind === 'text') continue
    const tag = piece.body
    const arg = piece.arg ?? ''
    try {
      if (tag === '表情') {
        if (arg === '') { missTexts.push('[表情: ]'); actions.push({ tag: '表情', result: '空描述，跳过', ok: false }); continue }
        if (await runSticker(deps, arg)) stickersSent += 1
        else { missTexts.push('[' + arg + ']'); deps.log(`chain emoji miss: [${arg}] — 四级查库落空，按文字表情发出`); actions.push({ tag: '表情', result: `查库落空，落字 [${arg}]`, ok: false }) }
      } else if (tag === '戳一戳') {
        if (deps.isGroup) {
          const uid = Number(arg.replace(/\D/g, ''))
          if (!uid) { actions.push({ tag: '戳一戳', result: '群聊戳人需要 QQ 号：[戳一戳: 号]', ok: false }); continue }
          await deps.client.call('group_poke', { group_id: deps.target, user_id: uid }, 8_000)
          actions.push({ tag: '戳一戳', result: `已戳群成员 ${uid}`, ok: true })
        } else {
          await deps.client.call('friend_poke', { user_id: deps.target }, 8_000)
          actions.push({ tag: '戳一戳', result: '已戳对方', ok: true })
        }
      } else if (tag === '点赞') {
        if (deps.isGroup) { actions.push({ tag: '点赞', result: '资料点赞仅私聊可用，跳过', ok: false }); continue }
        const times = Math.min(Math.max(Number(arg.replace(/\D/g, '')) || 1, 1), 10)
        await deps.client.call('send_like', { user_id: deps.target, times }, 8_000)
        actions.push({ tag: '点赞', result: `已点赞 ${times} 次`, ok: true })
      } else if (tag === '回应') {
        if (!deps.reactMessageId) { actions.push({ tag: '回应', result: '没有可回应的消息（quote 自带被引消息；qq_send_text 需带 reactToId）', ok: false }); continue }
        const emojiId = arg === '' ? '4' : arg // 4 = QQ 小表情赞
        await deps.client.call('set_msg_emoji_like', { message_id: String(deps.reactMessageId), emoji_id: emojiId, set: true }, 8_000)
        actions.push({ tag: '回应', result: `已给消息 ${deps.reactMessageId} 贴 [${emojiId}]`, ok: true })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e).slice(0, 80)
      deps.log(`chain ${tag} fail: ${msg}`)
      actions.push({ tag, result: `失败：${msg}`, ok: false })
    }
  }

  // 剩余正文：文本片段原样拼回 + miss 标记按文字表情独立成行（分段器按行切）
  let text = pieces.filter(p => p.kind === 'text').map(p => p.body).join('').replace(/\n{2,}/g, '\n').trim()
  if (missTexts.length > 0) text = (text.trimEnd() + '\n' + missTexts.join('\n')).trim()
  return { text, stickersSent, actions }
}
