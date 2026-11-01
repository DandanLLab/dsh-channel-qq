/** Sticker (emoji) store: steal images from the primary group, auto-attach on replies.
 *
 * Deliberately a lite port: an earlier OneBot extension's VLM intensity scoring is
 * not carried over; stealing is keyword-free and sending is probability-based.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EmojiConfig } from './config.js'
import type { OneBotClient } from './onebot.js'
import type { OneBotEvent } from './types.js'
import { parseInbound } from './segments.js'
import type { EmojiLibrary, EmojiIndexEntry } from './emoji-library.js'

export class EmojiStore {
  private readonly dir: string
  private readonly registeredDir: string

  constructor(
    config: EmojiConfig,
    private readonly client: OneBotClient,
    private readonly log: (line: string) => void,
    private readonly library?: EmojiLibrary,
  ) {
    this.dir = config.dir ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'), 'channel-qq', 'emoji')
    this.registeredDir = config.registeredDir ?? path.join(this.dir, '..', 'emoji-registered')
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.mkdir(this.registeredDir, { recursive: true })
  }

  /** Steal the first image of a primary-group message into the raw sticker dir. */
  async steal(event: OneBotEvent): Promise<EmojiIndexEntry | null> {
    const parsed = parseInbound(event)
    const url = parsed.imageUrls[0]
    if (url === undefined) return null
    try {
      const ext = path.extname(new URL(url).pathname).replace(/[^.\w]/g, '') || '.png'
      const target = path.join(this.dir, `stolen_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      // 2026-10-25 owner 令（隐私事故）：偷图前拒收非表情——
      // ①真实格式必须是 png/gif/jpg（webp/bmp 拒）；②jpg 且尺寸≥1000px 或体积≥140KB 的照片/截图拒收；
      // ③竖屏手机比例（1080x2400 类）拒收。这些是私照/截图，绝不入表情库。
      const real = (() => {
        if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png'
        if (buf.length > 3 && buf[0] === 0x47 && buf[1] === 0x49) return 'gif'
        if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
        if (buf.length > 12 && buf.subarray(0, 4).toString('binary') === 'RIFF') return 'webp'
        return 'unknown'
      })()
      if (real === 'webp' || real === 'unknown') {
        this.log(`sticker rejected: format ${real} 不像表情包`)
        return null
      }
      if (real === 'jpg') {
        let w = 0, h = 0
        try {
          let i = 2
          while (i < buf.length - 9) {
            if (buf[i] !== 0xff) { i++; continue }
            const m = buf[i + 1]
            if (m === 0xc0 || m === 0xc1 || m === 0xc2) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break }
            if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
            i += 2 + buf.readUInt16BE(i + 2)
          }
        } catch { /* 尺寸读不出按原图放行 */ }
        // 2026-10-28 owner 令（截图混库事故）：手机截图必带 EXIF，真表情包过手聊天工具极少带——带 EXIF 的 jpg 一律拒收
        if (buf.includes(Buffer.from('Exif'))) {
          this.log(`sticker rejected: jpg 带 EXIF（手机图/截图特征），不入表情库`)
          return null
        }
        if (w >= 1000 && h >= 1000 && buf.length >= 140000) {
          this.log(`sticker rejected: jpg ${w}x${h} ${Math.round(buf.length / 1024)}KB 像照片/截图，不入表情库`)
          return null
        }
        // 竖长/横扁比例 ≥1.9 = 截图/聊天记录形状（表情包是方的），体积门槛取消（小截图也要拦）
        if (w > 0 && h > 0 && Math.max(w, h) / Math.min(w, h) >= 1.9) {
          this.log(`sticker rejected: 长宽比 ${w}x${h} 像截图/横幅，不入表情库`)
          return null
        }
        if (h >= 2000 && buf.length >= 100000) {
          this.log(`sticker rejected: 竖长图 ${w}x${h} 像聊天记录/手机截图，不入表情库`)
          return null
        }
      }
      // PNG 侧同比例闸(截图也可能是 png)
      if (real === 'png' && buf.length > 26) {
        const pw = buf.readUInt32BE(16), ph = buf.readUInt32BE(20)
        if (pw > 0 && ph > 0 && Math.max(pw, ph) / Math.min(pw, ph) >= 1.9) {
          this.log(`sticker rejected: png 长宽比 ${pw}x${ph} 像截图/横幅，不入表情库`)
          return null
        }
      }
      await fs.writeFile(target, buf)
      this.log(`stole sticker → ${path.basename(target)}`)
      if (this.library !== undefined) {
        const entry = await this.library.addFile(target, 'stolen')
        if (entry === null) {
          this.log('duplicate sticker (md5 known), not indexed again')
          return null
        }
        return entry
      }
      return null
    } catch (error) {
      this.log(`sticker steal failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** Pick one registered sticker for auto-send; returns an absolute path or null. */
  async pickRegistered(): Promise<string | null> {
    try {
      const files = (await fs.readdir(this.registeredDir)).filter((name) => !name.startsWith('.'))
      if (files.length === 0) return null
      return path.join(this.registeredDir, files[Math.floor(Math.random() * files.length)]!)
    } catch {
      return null
    }
  }

  async sendRandom(isGroup: boolean, chatId: number): Promise<void> {
    const file = await this.pickRegistered()
    if (file === null) return
    const message = [{ type: 'image', data: { file: `file://${file}` } }]
    const action = isGroup ? 'send_group_msg' : 'send_private_msg'
    const payload = isGroup ? { group_id: chatId, message } : { user_id: chatId, message }
    try {
      await this.client.call(action, payload)
    } catch (error) {
      this.log(`auto emoji send failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
