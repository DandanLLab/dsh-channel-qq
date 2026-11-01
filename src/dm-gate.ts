/** 陌生人私聊门控（主人审计白名单）。
 *
 * 非 admins 的私聊默认不进 agent：先查 QQ 好友列表，好友直通；
 * 非好友进待审名单（持久化 <dshHome>/channel-qq/dm-gate.json），
 * 给陌生人回统一文案、给主人发一条待审通知。
 * 主人用 `qq_dm_gate` 工具（action=approve/deny/list）或把对方号
 * 加进 `dmGate.allowList` 放行；被拒的号进冷却（再发不通知不回复）。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { OneBotClient } from './onebot.js'
import type { DmGateConfig } from './config.js'

interface GateState {
  /** approved: 放行（主人审计过 / 好友自动）；denied: 拒绝（冷却）；pending: 待审 */
  [userId: string]: { status: 'approved' | 'denied' | 'pending'; at: number; note?: string }
}

export class DmGate {
  private state: GateState = {}
  private loaded = false
  private readonly file: string

  constructor(
    dshHome: string,
    private readonly config: DmGateConfig,
    private readonly admins: number[],
    private readonly client: () => OneBotClient | null,
    private readonly log: (line: string) => void,
  ) {
    this.file = path.join(dshHome, 'channel-qq', 'dm-gate.json')
  }

  async load(): Promise<void> {
    try {
      this.state = JSON.parse(await fs.readFile(this.file, 'utf8')) as GateState
    } catch { this.state = {} }
    this.loaded = true
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.writeFile(this.file, JSON.stringify(this.state, null, 1))
    } catch (e) { this.log(`dm-gate save failed: ${e instanceof Error ? e.message : String(e)}`) }
  }

  /** 好友列表（带 30s 缓存；查不到按 null=不判断，保守放行走 pending 流程） */
  private friendsCache: { at: number; ids: Set<number> | null } = { at: 0, ids: null }
  private async friendIds(): Promise<Set<number> | null> {
    if (Date.now() - this.friendsCache.at < 30_000) return this.friendsCache.ids
    const client = this.client()
    if (client === null) return this.friendsCache.ids
    const list = await client.call('get_friend_list', {}, 8000).catch(() => null) as Array<{ user_id?: number }> | null
    const ids = Array.isArray(list) ? new Set(list.map((f) => Number(f.user_id))) : null
    this.friendsCache = { at: Date.now(), ids }
    return ids
  }

  /** 判定：true=放行进 agent；false=已拦截（回复/通知已发出）。 */
  async admit(userId: number, nickname: string): Promise<boolean> {
    if (!this.config.enabled) return true
    if (!this.loaded) await this.load()
    if (this.admins.includes(userId)) return true
    if (this.config.allowList.includes(userId)) return true

    const rec = this.state[String(userId)]
    if (rec?.status === 'approved') return true
    if (rec?.status === 'denied') {
      this.log(`dm-gate: denied user ${userId} messaged again — silently dropped`)
      return false
    }

    // 好友自动放行（首次遇到时记档，之后不再查）
    const friends = await this.friendIds()
    if (friends !== null && friends.has(userId)) {
      this.state[String(userId)] = { status: 'approved', at: Date.now(), note: 'auto: friend' }
      await this.save()
      return true
    }

    // 陌生人：pending
    if (rec?.status !== 'pending') {
      this.state[String(userId)] = { status: 'pending', at: Date.now(), note: nickname.slice(0, 40) }
      await this.save()
      this.log(`dm-gate: stranger ${userId}(${nickname}) pending approval`)
      if (this.config.notifyAdmin) await this.notifyAdmin(userId, nickname)
    } else {
      this.log(`dm-gate: stranger ${userId} still pending — reminded reply only`)
    }

    // 给陌生人回统一文案（不进 agent、不耗模型）
    const client = this.client()
    if (client !== null && this.config.pendingReply) {
      void client.call('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text: this.config.pendingReply } }] })
        .catch((e) => this.log(`dm-gate pending reply failed: ${String(e).slice(0, 80)}`))
    }
    return false
  }

  private notifiedAt = 0
  private async notifyAdmin(userId: number, nickname: string): Promise<void> {
    const master = this.admins[0]
    if (master === undefined) return
    // 同一陌生人 10 分钟内只通知一次；全局 60 秒内不连发（防轰炸）
    const rec = this.state[String(userId)]
    if (rec?.note?.includes('notified:')) return
    if (Date.now() - this.notifiedAt < 60_000) return
    this.notifiedAt = Date.now()
    const client = this.client()
    if (client === null) return
    const text = `【私聊待审】QQ ${userId}（${nickname || '无名'}）刚才私信了我。回复用 qq_dm_gate action=approve userId=${userId} 放行，或 action=deny 拒绝。`
    void client.call('send_private_msg', { user_id: master, message: [{ type: 'text', data: { text } }] })
      .then(() => {
        if (rec) rec.note = (rec.note ?? '') + ' notified:'
      })
      .catch((e) => this.log(`dm-gate admin notify failed: ${String(e).slice(0, 80)}`))
  }

  /** 通用预警：给主人发一条安全通知（限频：同 key 10 分钟一次，全局 60 秒连发保护）。 */
  private alertSeen = new Map<string, number>()
  async alert(text: string, dedupeKey: string): Promise<void> {
    const master = this.admins[0]
    if (master === undefined) return
    const last = this.alertSeen.get(dedupeKey) ?? 0
    if (Date.now() - last < 10 * 60_000) return
    if (Date.now() - this.notifiedAt < 60_000) return
    this.notifiedAt = Date.now()
    this.alertSeen.set(dedupeKey, Date.now())
    const client = this.client()
    if (client === null) return
    void client.call('send_private_msg', { user_id: master, message: [{ type: 'text', data: { text: text.slice(0, 500) } }] })
      .catch((e) => this.log(`gate admin alert failed: ${String(e).slice(0, 80)}`))
  }

  /** 主人审计操作。 */
  async review(action: 'approve' | 'deny' | 'list', userId?: number): Promise<unknown> {
    if (!this.loaded) await this.load()
    if (action === 'list') {
      return { ok: true, entries: Object.entries(this.state).map(([id, r]) => ({ userId: Number(id), ...r })) }
    }
    if (userId === undefined) return { ok: false, error: 'approve/deny 需要 userId' }
    if (!this.admins.includes(userId) && action === 'approve' && !this.config.allowList.includes(userId)) {
      // approve 一个不在 allowList 的号：临时放行但记 approved（主人显式行为）
    }
    this.state[String(userId)] = { status: action === 'approve' ? 'approved' : 'denied', at: Date.now(), note: 'manual review' }
    await this.save()
    this.log(`dm-gate: ${action} ${userId}`)
    return { ok: true, userId, status: action === 'approve' ? 'approved' : 'denied' }
  }
}
