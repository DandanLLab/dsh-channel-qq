/** QQ 设置 API: settings-page backend for the bundled QQ settings section.
 *
 * GET  /channel-qq-api          → live hot settings (subset)
 * POST /channel-qq-api {patch}  → mutate the live config object in place
 *                                 (hot-apply: talkValue/requireMention/persona/
 *                                  dmGate/emoji take effect on the next event)
 *                                 and persist to <dshHome>/channel-qq/settings.json
 *                                 (re-applied over defaults on every boot).
 *
 * Security: loopback-only via Host-header check (DNS-rebinding safe, same as
 * the meme component), no secrets returned.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { describeClient, capabilityMatrixOf } from './client-compat.js'
import type { Context } from '@deepseek-ai/cordis'
import type { QQChannelConfig } from './config.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function denyNonLoopback(req: { headers: { host?: string } }, res: { writeHead: (n: number, h?: Record<string, string>) => void; end: (s?: string) => void }): boolean {
  const raw = String(req.headers.host ?? '')
  const name = raw.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '')
  if (LOOPBACK_HOSTS.has(name.toLowerCase())) return false
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('loopback only')
  return true
}

/** Whitelisted hot fields and their types (everything else is ignored). */
const HOT_SCALARS: Record<string, 'number' | 'boolean' | 'string'> = {
  'talkValue': 'number',
  'requireMention': 'boolean',
  'persona.selfName': 'string',
  'persona.masterName': 'string',
  'persona.peerName': 'string',
  'persona.pronoun': 'string',
  'dmGate.enabled': 'boolean',
  'dmGate.notifyAdmin': 'boolean',
  'dmGate.pendingReply': 'string',
  'emoji.steal': 'boolean',
  'emoji.autoSend': 'boolean',
}

function getPath(obj: unknown, dotPath: string): unknown {
  let cur: any = obj
  for (const seg of dotPath.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function setPath(obj: unknown, dotPath: string, value: unknown): void {
  const segs = dotPath.split('.')
  let cur = obj as Record<string, unknown>
  for (let i = 0; i < segs.length - 1; i++) {
    if (typeof cur[segs[i]] !== 'object' || cur[segs[i]] === null) cur[segs[i]] = {}
    cur = cur[segs[i]] as Record<string, unknown>
  }
  cur[segs[segs.length - 1]] = value
}

export function registerSettingsApi(ctx: Context, config: QQChannelConfig, dshHome: string, log: (line: string) => void, client?: { clientIdentity: import('./client-compat.js').ClientIdentity | null; connection: { mode: string; url: string }; isConnected?: () => boolean }): () => void {
  const overlayFile = path.join(dshHome, 'channel-qq', 'settings.json')

  /** Boot-time: re-apply the persisted overlay over the resolved config. */
  async function applyOverlay(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(overlayFile, 'utf8')) as Record<string, unknown>
      let applied = 0
      for (const [k, v] of Object.entries(raw)) {
        if (!(k in HOT_SCALARS)) continue
        setPath(config, k, v)
        applied++
      }
      if (applied > 0) log(`settings-api: overlay applied (${applied} fields from settings.json)`)
    } catch { /* no overlay yet */ }
  }
  void applyOverlay()

  let webServer: { register(route: { kind: string; path: string; handler: (req: any, res: any) => void }): () => void } | undefined
  try {
    webServer = (ctx as unknown as { webServer?: typeof webServer }).webServer
  } catch { webServer = undefined }

  if (webServer === undefined) {
    log('settings-api: webServer unavailable — settings page read-only off')
    return () => {}
  }

  const json = (res: any, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const offGetTest = webServer.register({
    kind: 'exact',
    path: '/channel-qq-api/test',
    handler: (req: any, res: any) => {
      if (denyNonLoopback(req, res)) return
      if (req.method === 'GET') {
        const id = client?.clientIdentity ?? null
        json(res, 200, { ok: true, connected: client?.isConnected?.() ?? null, client: id, describe: id ? describeClient(id) : '尚未探测到（连接刚建立或探测失败）', capabilities: id ? capabilityMatrixOf(id.kind) : {} })
        return
      }
      if (req.method === 'POST') {
        let bodyRaw = ''
        req.on('data', (c: string) => { if (bodyRaw.length < 100_000) bodyRaw += c })
        req.on('end', async () => {
          try {
            const patch = JSON.parse(bodyRaw) as Record<string, unknown>
            const applied: string[] = []
            for (const [k, v] of Object.entries(patch)) {
              const kind = HOT_SCALARS[k]
              if (kind === undefined) continue
              const coerced = kind === 'number' ? Number(v)
                : kind === 'boolean' ? (v === true || v === 'true')
                : String(v ?? '').slice(0, 200)
              if (kind === 'number' && !Number.isFinite(coerced as number)) continue
              setPath(config, k, coerced)
              applied.push(k)
            }
            // persist overlay (re-applied on every boot)
            const overlay: Record<string, unknown> = {}
            for (const k of applied) overlay[k] = getPath(config, k)
            await fs.mkdir(path.dirname(overlayFile), { recursive: true })
            await fs.writeFile(overlayFile, JSON.stringify(overlay, null, 1))
            log(`settings-api: saved ${applied.length} fields`)
            json(res, 200, { ok: true, applied })
          } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        })
        return
      }
      json(res, 405, { ok: false, error: 'method' })
    },
  })

  const offGet = webServer.register({
    kind: 'exact',
    path: '/channel-qq-api',
    handler: (req: any, res: any) => {
      if (denyNonLoopback(req, res)) return
      if (req.method === 'GET') {
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(HOT_SCALARS)) out[k] = getPath(config, k)
        json(res, 200, {
          ok: true,
          settings: out,
          client: client?.clientIdentity ?? null,
          connection: { mode: client?.connection.mode ?? config.connection.mode, url: client?.connection.url ?? config.connection.url },
        })
        return
      }
      if (req.method === 'POST') {
        let bodyRaw = ''
        req.on('data', (c: string) => { if (bodyRaw.length < 100_000) bodyRaw += c })
        req.on('end', async () => {
          try {
            const patch = JSON.parse(bodyRaw) as Record<string, unknown>
            const applied: string[] = []
            for (const [k, v] of Object.entries(patch)) {
              const kind = HOT_SCALARS[k]
              if (kind === undefined) continue
              const coerced = kind === 'number' ? Number(v)
                : kind === 'boolean' ? (v === true || v === 'true')
                : String(v ?? '').slice(0, 200)
              if (kind === 'number' && !Number.isFinite(coerced as number)) continue
              setPath(config, k, coerced)
              applied.push(k)
            }
            const overlay: Record<string, unknown> = {}
            for (const k of applied) overlay[k] = getPath(config, k)
            await fs.mkdir(path.dirname(overlayFile), { recursive: true })
            await fs.writeFile(overlayFile, JSON.stringify(overlay, null, 1))
            log(`settings-api: saved ${applied.length} fields`)
            json(res, 200, { ok: true, applied })
          } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        })
        return
      }
      json(res, 405, { ok: false, error: 'method' })
    },
  })

  log('settings-api: /channel-qq-api registered (loopback only)')
  return () => { offGetTest(); offGet() }
}
