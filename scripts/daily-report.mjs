import path from 'node:path'
#!/usr/bin/env node
/**
 * QQ 群日报生成器（独立脚本，不进 dsh 进程）。
 *
 * 思路来自 astrbot_plugin_qq_group_daily_analysis，但数据源不同：
 * 不需要自己攒消息 —— dsh 的 session.v3.jsonl.zstd 就是全量事件日志。
 *
 * 用法:
 *   node daily-report.mjs [--date YYYY-MM-DD] [--group 10002]
 *
 * 输出: <dshHome>/channel-qq/daily-report-<date>.md
 * 之后由 agent（或用户）把报告发到群里；也可以挂系统计划任务每天生成。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const group = argOf('--group', '10002')
// default: yesterday
const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
const date = argOf('--date', yesterday)

const sid = `qq-group-${group}`
const tree = process.env.CHANNEL_QQ_SESSION_ROOT
if (!tree) {
  console.error('CHANNEL_QQ_SESSION_ROOT not set (dsh sessions tree dir)')
  process.exit(1)
}
const logPath = join(tree, sid, 'session.v3.jsonl.zstd')
if (!existsSync(logPath)) {
  console.error(`session log not found: ${logPath}`)
  process.exit(1)
}

const zlib = await import('node:zlib')
const buf = readFileSync(logPath)
// multi-frame zstd: dsh appends one frame per write
const starts = []
for (let i = 0; i <= buf.length - 4; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
}
starts.push(buf.length)
let jsonl = ''
for (let k = 0; k < starts.length - 1; k++) {
  try { jsonl += zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])).toString('utf8') } catch {}
}

const events = jsonl.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const dayStart = Date.parse(`${date}T00:00:00+08:00`)
const dayEnd = dayStart + 24 * 3600 * 1000

// Reconstruct the readable message stream for the day.
//
// The channel hands the agent batch packets that look like this:
//
//   【群里的新消息】
//   17:25 蛋(10001)[群主] #987507911：[图片][图片含义：[动画表情]]
//   （该回就回，用 qq_send_text / qq_reply_quote；不需要发言就不调用发送工具。…）
//
// Only the middle line is a real chat message. Keep the packet headers/footers
// out of the report, and parse each message line for its own local HH:MM
// (e.time is the injection time in UTC, which is NOT when the message was sent).
const packetHead = /^【(最近时段群里的消息|有人叫咱|群里的新消息)/
const msgLine = /^(\d{2}:\d{2})\s+(.+?)\((\d{5,})\)(?:\[[^\]]*\])?\s*#(\d+)\s*[：:]\s*([\s\S]*)$/

const msgs = []
const perUser = new Map()
const seenIds = new Set()

for (const e of events) {
  if (e.type !== 'user/message' || typeof e.time !== 'number') continue
  if (e.time < dayStart || e.time >= dayEnd) continue
  const content = e.data?.content
  if (!Array.isArray(content)) continue
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
  const images = content.filter((b) => b.type === 'image').length
  if (text === '' && images === 0) continue
  if (text.includes('This is an automatically generated checkpoint')) continue
  // skip harness/system noise: system-reminders, runtime context, skill lists
  if (text.startsWith('<system-reminder>') || text.startsWith('Current runtime context') || text.startsWith('Current DSH file policy')) continue
  // only the group-chat batch packets carry real messages
  if (!packetHead.test(text)) continue

  for (let line of text.split('\n')) {
    line = line.trim()
    if (line === '' || line.startsWith('（该回就回')) continue
    // strip the channel's optional "[引用 某人(QQ)：…]" prefix
    if (line.startsWith('[引用')) {
      const cut = line.lastIndexOf(']')
      if (cut < 0) continue
      line = line.slice(cut + 1).trim()
    }
    const m = line.match(msgLine)
    if (m === null) continue
    const [, hhmm, name, uidStr, id, rawBody] = m
    if (seenIds.has(id)) continue
    seenIds.add(id)
    const uid = Number(uidStr)
    let body = rawBody.trim().replace(/\[图片\]\[图片含义：\[[^\]]*\]\]/g, '[图]')
    if (body.length > 300) body = body.slice(0, 300) + '…'
    msgs.push({ time: hhmm, uid, name, body })
    if (uid > 0) perUser.set(uid, (perUser.get(uid) ?? 0) + 1)
  }
}

// packets can arrive out of order / overlap; sort by the message's own clock
msgs.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))

if (msgs.length === 0) {
  console.log(`no messages on ${date}; nothing to report`)
  process.exit(0)
}

const transcript = msgs.map((m) => `${m.time} ${m.name}(QQ${m.uid}): ${m.body}`).join('\n')
const nameByUid = new Map(msgs.map((m) => [m.uid, m.name]))
const stats = [...perUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
const statsBlock = stats.map(([uid, n]) => `- ${nameByUid.get(uid) ?? '?'}(QQ${uid}): ${n} 条`).join('\n')

const outDir = join(home, 'channel-qq')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `daily-report-${date}.md`)

const report = `# QQ 群 ${group} 日报 · ${date}

## 数据概览
- 当日消息量: ${msgs.length} 条
- 参与人数: ${perUser.size} 人

## 活跃排行
${statsBlock}

## 原始消息流（截选，共 ${msgs.length} 条）
\`\`\`
${transcript.slice(0, 24000)}
\`\`\`

> 本文件由 daily-report.mjs 自动生成。把上面内容交给模型总结，即可产出话题总结/用户画像/金句等分析段落。
`

writeFileSync(outFile, report, 'utf8')
console.log(`report written: ${outFile}`)
console.log(`messages: ${msgs.length}, participants: ${perUser.size}`)
