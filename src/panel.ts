/** QQ 频道控制台（web panel）后端。
 *
 * 结构：一张声明式路由表 + 每个域一个独立 status builder —— 以后加功能 =
 * 写一个 builder + 在 ROUTES 里加一行，前端在 PAGE 里加一张卡片。
 * 所有路由复用 settings-api 的回环守卫（Host header 校验，DNS-rebinding 安全），
 * 不返回任何密钥。
 *
 * GET  /qq-panel                 → 控制台页面（lib/qq-panel.html，构建时随 copy 步骤复制）
 * GET  /channel-qq-api/status    → 聚合实时状态（连接 / 会话窗口 / 陌生人门控 / 白名单）
 * GET  /channel-qq-api/log       → channel-qq.log 尾部（?lines=N，默认 120，上限 500）
 * POST /channel-qq-api/dm-gate   → {action:'approve'|'deny'|'list', userId?} 透传 DmGate.review
 * POST /channel-qq-api/reconnect → OneBotClient.forceReconnect()（重置退避并立即重拨）
 */

import { readFileSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeClient } from './client-compat.js'
import type { Context } from '@deepseek-ai/cordis'
import type { QQChannelConfig } from './config.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const LOG_FILE_MAX_BYTES = 256 * 1024

function denyNonLoopback(req: { headers: { host?: string } }, res: { writeHead: (n: number, h?: Record<string, string>) => void; end: (s?: string) => void }): boolean {
  const raw = String(req.headers.host ?? '')
  const name = raw.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '')
  if (LOOPBACK_HOSTS.has(name.toLowerCase())) return false
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('loopback only')
  return true
}

export interface PanelDeps {
  client?: {
    selfId: number | null
    clientIdentity: import('./client-compat.js').ClientIdentity | null
    connection: { mode: string; url: string }
    isConnected?: () => boolean
    forceReconnect?: () => void
  } | null
  bridge?: {
    snapshot(): Array<{
      key: string
      isGroup: boolean
      chatId: number
      sessionId: string
      live: boolean
      pending: boolean
      queued: number
      lastEventTime: number | null
    }>
  } | null
  dmGate?: {
    review(action: 'approve' | 'deny' | 'list', userId?: number): Promise<unknown>
  } | null
}

interface RouteSpec {
  method: 'GET' | 'POST'
  path: string
  handler: (req: any, res: any, url: URL) => void | Promise<void>
}

export function registerPanel(ctx: Context, config: QQChannelConfig, dshHome: string, log: (line: string) => void, deps: PanelDeps): () => void {
  const startedAt = Date.now()
  const logFile = path.join(dshHome, 'channel-qq.log')
  let version = ''
  try {
    version = String((JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '')
  } catch { /* unknown version */ }

  // ---- per-domain status builders（加卡片 = 加一个 builder）----

  function buildConnection() {
    const id = deps.client?.clientIdentity ?? null
    return {
      connected: deps.client?.isConnected?.() ?? false,
      selfId: deps.client?.selfId ?? config.selfId,
      mode: deps.client?.connection.mode ?? config.connection.mode,
      url: deps.client?.connection.url ?? config.connection.url,
      client: id,
      describe: id ? describeClient(id) : '尚未探测到（连接刚建立或探测失败）',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      version,
    }
  }

  function buildWindows() {
    return { windows: deps.bridge?.snapshot() ?? [] }
  }

  async function listGate(): Promise<Array<{ userId: number; status: string; at: number; note?: string }>> {
    const result = (await deps.dmGate?.review('list')) as { ok?: boolean; entries?: Array<{ userId: number; status: string; at: number; note?: string }> } | undefined
    return Array.isArray(result?.entries) ? result.entries : []
  }

  function buildWhitelist() {
    return {
      primaryGroup: config.primaryGroup,
      extraGroups: config.extraGroups ?? [],
      admins: config.admins,
      groupEnabled: config.groupEnabled,
    }
  }

  // ---- 文件浏览（只读，沙箱限制在固定根目录内） ----

  // ---- 日记（生活引擎 self/90-日记/*.md）----
  const DIARY_DIR = () => path.join(config.workspacePath || path.join(dshHome, 'channel-qq-workspace'), 'self', '90-日记')
  const DIARY_MAX_ENTRIES = 60
  const DIARY_TEXT_MAX = 20 * 1024

  function readDiaryDir(dir: string, demo: boolean) {
    let names: string[] = []
    try { names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)) } catch { names = [] }
    const entries: Array<{ date: string; size: number; mtime: number; text: string; demo?: boolean }> = []
    for (const name of names.sort().reverse().slice(0, DIARY_MAX_ENTRIES)) {
      try {
        const st = statSync(path.join(dir, name))
        const buf = readFileSync(path.join(dir, name))
        entries.push({ date: name.slice(0, 10), size: st.size, mtime: st.mtimeMs, text: buf.subarray(0, DIARY_TEXT_MAX).toString('utf8'), ...(demo ? { demo: true } : {}) })
      } catch { /* raced deletion */ }
    }
    return entries
  }

  function listDiary() {
    // [local/demo] 工作区还没有日记时，回落到演示目录（panel-demo），条目带 demo 标记
    const entries = readDiaryDir(DIARY_DIR(), false)
    if (entries.length > 0) return entries
    return readDiaryDir(path.join(dshHome, 'panel-demo', 'self', '90-日记'), true)
  }

  // ---- 情感 / 知识库 / 自我文件 / 任务流 ----
  function readJsonSafe(file: string): any {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  }

  const SELF_DOCS = ['99-种子.md', '95-成长层.md', '85-心境.md', 'user心智模型.md', '自我认知.md', 'user画像.md'] as const
  const DOC_TEXT_MAX = 32 * 1024

  function workspaceDir(...parts: string[]): string {
    return path.join(config.workspacePath || path.join(dshHome, 'channel-qq-workspace'), ...parts)
  }

  function readAffection() {
    const affection = readJsonSafe(path.join(dshHome, 'affection.json'))
    const sixdim = readJsonSafe(path.join(dshHome, 'emotion-sixdim.json'))
    const emotion = readJsonSafe(path.join(dshHome, 'emotion.json'))
    return { ok: true as const, affection, sixdim, emotion }
  }

  function listKnowledge() {
    let entries: any[] = []
    try {
      const parsed = readJsonSafe(workspaceDir('knowledge', 'entries.json'))
      if (Array.isArray(parsed)) entries = parsed
    } catch { entries = [] }
    return { ok: true as const, entries }
  }

  function readSelfDocs() {
    return SELF_DOCS.map((name) => {
      let text: string | null = null
      try { text = readFileSync(workspaceDir('self', name), 'utf8').slice(0, DOC_TEXT_MAX) } catch { text = null }
      return { name, text }
    })
  }

  function listInteractions() {
    let events: any[] = []
    try {
      const lines = readFileSync(workspaceDir('knowledge', 'interactions.jsonl'), 'utf8').split('\n').filter(Boolean)
      for (const line of lines.slice(-300)) {
        try { events.push(JSON.parse(line)) } catch { /* skip bad line */ }
      }
    } catch { events = [] }
    return { ok: true as const, events }
  }

  // ---- log tail ----

  function tailLog(lines: number): string[] {
    try {
      const stat = statSync(logFile)
      const len = Math.min(LOG_FILE_MAX_BYTES, stat.size)
      const buf = Buffer.alloc(len)
      const fd = openSync(logFile, 'r')
      try {
        readSync(fd, buf, 0, len, stat.size - len)
      } finally {
        closeSync(fd)
      }
      const all = buf.toString('utf8').split('\n').filter(Boolean)
      return all.slice(-lines)
    } catch {
      return []
    }
  }

  // ---- declarative route table（加功能 = 加一行）----

  const ROUTES: RouteSpec[] = [
    {
      method: 'GET', path: '/qq-panel',
      handler: (_req, res) => {
        try {
          const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'qq-panel.html'))
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(html)
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('qq-panel.html 缺失: ' + (error instanceof Error ? error.message : String(error)))
        }
      },
    },
    {
      method: 'GET', path: '/channel-qq-api/status',
      handler: async (_req, res) => {
        const gate = await listGate()
        json(res, 200, {
          ok: true,
          now: new Date().toISOString(),
          connection: buildConnection(),
          windows: buildWindows().windows,
          gate,
          whitelist: buildWhitelist(),
        })
      },
    },
    {
      method: 'GET', path: '/channel-qq-api/log',
      handler: (req, res, url) => {
        const lines = Math.max(20, Math.min(500, Number(url.searchParams.get('lines')) || 120))
        json(res, 200, { ok: true, lines: tailLog(lines) })
      },
    },
    {
      method: 'GET', path: '/channel-qq-api/diary',
      handler: (_req, res) => {
        json(res, 200, { ok: true, entries: listDiary() })
      },
    },
    {
      method: 'GET', path: '/channel-qq-api/affection',
      handler: (_req, res) => {
        json(res, 200, readAffection())
      },
    },
    {
      method: 'GET', path: '/channel-qq-api/knowledge',
      handler: (_req, res) => {
        json(res, 200, listKnowledge())
      },
    },
    {
      method: 'GET', path: '/channel-qq-api/self',
      handler: (_req, res) => {
        json(res, 200, { ok: true, files: readSelfDocs() })
      },
    },
    {
      method: 'GET', path: '/channel-qq-api/interactions',
      handler: (_req, res) => {
        json(res, 200, listInteractions())
      },
    },
    {
      method: 'POST', path: '/channel-qq-api/dm-gate',
      handler: async (req, res) => {
        const body = await readBody(req)
        try {
          const patch = JSON.parse(body || '{}') as { action?: string; userId?: number }
          const action = patch.action === 'approve' || patch.action === 'deny' || patch.action === 'list' ? patch.action : null
          if (!action) return json(res, 400, { ok: false, error: 'action 必须是 approve/deny/list' })
          const result = await deps.dmGate?.review(action, patch.userId)
          log(`panel: dm-gate ${action}${patch.userId !== undefined ? ` ${patch.userId}` : ''}`)
          json(res, 200, { ok: true, result: result ?? null })
        } catch (e) {
          json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'POST', path: '/channel-qq-api/reconnect',
      handler: async (_req, res) => {
        if (typeof deps.client?.forceReconnect !== 'function') return json(res, 400, { ok: false, error: 'client 不可用' })
        deps.client.forceReconnect()
        log('panel: manual reconnect requested')
        json(res, 200, { ok: true })
      },
    },
  ]

  let webServer: { register(route: { kind: string; path: string; handler: (req: any, res: any) => void }): () => void } | undefined
  try {
    webServer = (ctx as unknown as { webServer?: typeof webServer }).webServer
  } catch { webServer = undefined }
  if (webServer === undefined) {
    log('panel: webServer unavailable — /qq-panel off')
    return () => {}
  }

  const disposers: Array<() => void> = []
  for (const route of ROUTES) {
    disposers.push(webServer.register({
      kind: 'exact',
      path: route.path,
      handler: (req: any, res: any) => {
        if (denyNonLoopback(req, res)) return
        if (req.method !== route.method) {
          res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'method' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        void Promise.resolve(route.handler(req, res, url)).catch((e) => {
          if (!res.headersSent) json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
        })
      },
    }))
  }

  log(`panel: /qq-panel + ${ROUTES.length - 1} API routes registered (loopback only)`)
  return () => { for (const off of disposers) off() }
}

function json(res: any, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req: any, maxBytes = 100_000): Promise<string> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c: string) => { if (raw.length < maxBytes) raw += c })
    req.on('end', () => resolve(raw))
    req.on('error', () => resolve(raw))
  })
}
