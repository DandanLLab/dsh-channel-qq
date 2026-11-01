#!/usr/bin/env node
// kb.cjs — QQ 知识库 v2 全库检索 CLI(纯 node 零依赖 · 记忆体系 L2 · 2026-10-06)
// 用法: node kb.cjs index | search <词句> [--cat 类别|--sub 子类|--agent <id>] | mentions <串> | stats | tags
//       sesindex | sessearch <词句> [--agent <id>] | sesmentions <串> [--agent <id>] | sesstats | presearch [--agent <id>]
// 架构: md→分块→本地向量(127.0.0.1:17861 bge-small-zh 512维)→.kb-index.jsonl
//       检索=余弦 topK + mentions 确定性 grep 兜底(抄 KB v5.9.3 检索哲学)
// 设计取舍(2026-10-06 实测教训):弃 lancedb 逐条 store(版本快照膨胀 600MB),
//       jsonl 自持索引 30MB 级、查询百毫秒、可 grep 可续跑。
// 2026-10-27 记忆隔离大改(施工单:侦察/记忆隔离改进方案_2026-10-27.md):
//       刀一 L1 会话层行内 agent 字段(路径推导,不加人工配置);
//       刀二 sessearch/sesmentions/presearch --agent 过滤(score 之前,bin 行序对齐);
//       刀三 L2 知识库 --agent 专属子目录 knowledge/<agent>/(根目录=公共知识,任何 agent 可见);
//       刀五 sessearch/presearch 内存止血:向量 bin 按需读 + jsonl 流式 top-k,全量载入消失。
'use strict'
// 中文 Windows 管道强制 UTF-8(chcp 治标,这里治本)
if (process.stdout.isTTY === false && typeof process.stdout.setEncoding === 'function') process.stdout.setEncoding('utf8')
const { readdirSync, readFileSync, writeFileSync, statSync, existsSync, renameSync, unlinkSync, appendFileSync, mkdirSync, openSync, readSync, closeSync, fstatSync } = require('node:fs')
const { join, relative } = require('node:path')

const WS = process.env.KB_WORKSPACE || ''
const KB_DIR = WS + '/knowledge'
const EMBED_URL = 'http://127.0.0.1:17861/v1/embeddings'

// ---- 分类路由层(2026-10-16):按文件相对路径自动归类,无需人工标注 ----
// knowledge/memory/learning/inbox 四个一级目录为主类别,根目录散文件=root;
// knowledge/ 下的二级子目录作为子类别(如 knowledge/AgentDuel/x.md → cat=knowledge sub=AgentDuel)
function catOf(rel) {
  if (rel.startsWith('knowledge/')) {
    const rest = rel.slice(10)
    const slash = rest.indexOf('/')
    return { cat: 'knowledge', sub: slash > 0 ? rest.slice(0, slash) : '' }
  }
  if (rel.startsWith('memory/')) return { cat: 'memory', sub: '' }
  if (rel.startsWith('learning/')) return { cat: 'learning', sub: '' }
  if (rel.startsWith('inbox/')) return { cat: 'inbox', sub: '' }
  return { cat: 'root', sub: '' }
}

// ---- agent 维度(2026-10-27 刀三):L2 专属库子目录 = knowledge/<agent>/ ----
// 根库(无 --agent)不收任何专属目录;--agent A 的库收 公共(根 knowledge/memory/learning)+ A 专属。
const AGENT_KB_SET = new Set((process.env.KB_AGENTS || 'tongling,yobiru,host,today').split(',').map(s2 => s2.trim()).filter(Boolean))
function agentOwnDir(rel) {
  if (!rel.startsWith('knowledge/')) return ''
  const seg = rel.slice(10).split('/')[0]
  return AGENT_KB_SET.has(seg) ? seg : ''
}
// --agent 全局解析一次(walk 过滤要用);命令内 query 解析由 parseSearchArgs 兼容双收
function parseAgentArgv() {
  const a = process.argv.slice(2)
  const i = a.indexOf('--agent')
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : ''
}
const KB_AGENT = parseAgentArgv()

// L2 作用域路径:agent='' → 根库(公共);agent=X → knowledge/X/ 专属库
function kbScope(agent) {
  const dir = agent ? `${KB_DIR}/${agent}` : KB_DIR
  return {
    dir,
    index: `${dir}/.kb-index.jsonl`,
    manifest: `${dir}/.kb-manifest.json`,
    shards: `${dir}/.kb-shards.json`,
    legacy: `${dir}/.kb-index.jsonl.legacy`,
    hitlog: `${dir}/.kb-hitlog.json`,
  }
}
function hitlogRec(obj) {
  const sc = kbScope(KB_AGENT)
  try { mkdirSync(sc.dir, { recursive: true }) } catch { }
  appendFileSync(sc.hitlog, JSON.stringify(obj) + '\n')
}

// ---- 记忆进化三件套(2026-10-29 owner 令:外挂记忆强化) ----
// ①最近召回加分:168h 内被召回过的文件按 72h 半衰指数加分(遗忘曲线逆操作——常被想起的记忆更靠前)
function recentMapLoad() {
  try { return JSON.parse(readFileSync(kbScope(KB_AGENT).dir + '/.kb-recent.json', 'utf8')) } catch { return {} }
}
function recentBoost(file) {
  const m = recentMapLoad()
  const t = m[file]
  if (!t) return 0
  const hours = (Date.now() - t) / 3600e3
  if (hours > 168) return 0
  return 0.05 * Math.exp(-hours / 72)
}
function recentMark(files) {
  try {
    const m = recentMapLoad()
    const now = Date.now()
    for (const f of files) m[f] = now
    writeFileSync(kbScope(KB_AGENT).dir + '/.kb-recent.json', JSON.stringify(m))
  } catch { }
}
// ---- 家族神经网(2026-10-29 owner 令:三种神经元全连) ----
// 神经元知识库=各 agent 分片库;神经元记忆流=ses 层;神经元任务流=interactions.jsonl;突触=graph.jsonl
const INTERACTIONS = WS + '/knowledge/interactions.jsonl'
function interactionsAppend(ev) {
  try { appendFileSync(INTERACTIONS, JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n') } catch { }
}
/** 扩散激活(HippoRAG 式):种子=命中节点,2 跳衰减,收集激活的文件/任务节点 */
function graphActivate(query, topN = 6) {
  try {
    const gp = WS + '/knowledge/graph.jsonl'
    if (!existsSync(gp)) return []
    const qs = String(query).toLowerCase()
    const terms = qs.split(/[\s，。、！？,.!?/|]+/).filter(x => x.length >= 2)
    const edges = []
    for (const l of readFileSync(gp, 'utf8').split('\n')) {
      if (!l.trim()) continue
      try { edges.push(JSON.parse(l)) } catch { }
    }
    const act = new Map() // nodeKey -> activation
    const seedEdges = []
    for (const e of edges) {
      const a = String(e.a || '').toLowerCase(), b = String(e.b || '').toLowerCase()
      if (terms.some(t => a.includes(t) || b.includes(t))) { seedEdges.push(e); act.set(e.a, (act.get(e.a) || 0) + 1); act.set(e.b, (act.get(e.b) || 0) + 1) }
    }
    // 1 跳扩散:用快照值,不做 live ping-pong(防反馈放大)
    const snap = new Map(act)
    for (const e of edges) {
      const a = snap.get(e.a)
      if (a) act.set(e.b, (act.get(e.b) || 0) + a * 0.5 * Math.min(e.w || 0.8, 1.0))
      const b = snap.get(e.b)
      if (b) act.set(e.a, (act.get(e.a) || 0) + b * 0.5 * Math.min(e.w || 0.8, 1.0))
    }
    // 归一化:激活值除以最大值,防多路径反馈放大
    let maxAct = 0
    for (const v of act.values()) if (v > maxAct) maxAct = v
    if (maxAct > 0) for (const [k, v] of act) act.set(k, v / maxAct)
    // 激活的节点挂着的边 → 收集文件/任务产物
    const scored = []
    for (const e of edges) {
      const s = Math.max(act.get(e.a) || 0, act.get(e.b) || 0)
      if (s <= 0) continue
      if (e.b && /\.(md|jsonl|gz)$/i.test(e.b)) scored.push({ file: e.b, s: s * Math.min(e.w || 0.8, 1.0), kind: '文件', text: (e.a || '') + ' -' + (e.rel || '?') + '→ ' + (e.source || '') })
      else if (e.type) scored.push({ file: '任务流[' + e.type + ']' + (e.from || '') + '→' + (e.to || ''), s: s * 0.6, kind: '任务', text: e.what || e.summary || '' })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, topN)
  } catch { return [] }
}
/** 记忆状态机(1029 owner 令):NEW→INDEXED→ACTIVE→DECAYING→ARCHIVED→FORGOTTEN */
const MEMSTATE = WS + '/knowledge/.kb-memstate.json'
function memStateLoad() { try { return JSON.parse(readFileSync(MEMSTATE, 'utf8')) } catch { return { archived: [], forgotten: [] } } }
function memStateSave(m) { try { writeFileSync(MEMSTATE, JSON.stringify(m, null, 1)) } catch { } }
async function cmdForget(file, agentArg) {
  const ag = agentArg || KB_AGENT
  const target = (WS + '/' + file).replace(/' + BS + BS + '/g, '/')
  if (!existsSync(target)) { console.log('[forget] 不存在: ' + file); return }
  const st = memStateLoad()
  st.forgotten.push({ file: file, at: new Date().toISOString(), by: 'master' })
  memStateSave(st)
  const trashDir = WS + '/knowledge/' + (ag || '') + '/_forgotten'
  try { mkdirSync(trashDir, { recursive: true }); renameSync(target, trashDir + '/' + file.split('/').pop()) } catch { }
  console.log('[forget] ' + file + ' → FORGOTTEN')
}
function cmdMemState() {
  const recent = recentMapLoad()
  const now = Date.now()
  const active = [], decaying = []
  for (const [f, t] of Object.entries(recent)) {
    const hours = (now - t) / 3600e3
    if (hours <= 168) active.push(f + ' (' + Math.round(hours) + 'h)')
    else decaying.push(f + ' (' + Math.round(hours / 24) + '天)')
  }
  const st = memStateLoad()
  console.log(JSON.stringify({ activeCount: active.length, decayingCount: decaying.length, forgotten: st.forgotten.length, decayingList: decaying.slice(0, 10) }, null, 1))
}
/** 全脑路由:全家四库+各 agent ses+图谱激活+任务流,一次查询全网合并 */
async function cmdBrain(query, agentArg) {
  const t0 = Date.now()
  const [qv] = await embed([query])
  const qn = Math.sqrt(qv.reduce((a, x) => a + x * x, 0)) || 1
  const out = []
  const scopes = agentArg ? ['', agentArg] : (process.env.KB_AGENTS || 'tongling,today,host').split(',').map(s2 => s2.trim()).filter(Boolean).concat([''])
  const regions = { tongling: '姐姐库', today: 'today库', host: '工程台库', '': '公共库' }
  for (const sc of scopes) {
    if (!isNewKb(sc)) continue
    try {
      const scored = await kbScoreAll(qv, null, sc)
      for (const x of scored.slice(0, 3)) if (x.s > 0.30) out.push({ region: regions[sc] || sc, file: x.r.file, text: x.r.text.replace(/\s+/g, ' ').slice(0, 100), s: Number(x.s.toFixed(3)) })
    } catch { }
  }
  if (existsSync(SES_INDEX)) {
    const { hits, noBin } = sesStreamTopK(qv, qn, 4, agentArg)
    if (!noBin) for (const x of hits) if (x.s > 0.28) out.push({ region: '记忆流[' + (x.r.agent || '?') + ']', file: x.r.key.split('/').slice(-2)[0].slice(0, 36), text: x.r.text.replace(/\s+/g, ' ').slice(0, 100), s: Number(x.s.toFixed(3)) })
  }
  for (const g of graphActivate(query, 6)) out.push({ region: '激活' + (g.kind || ''), file: String(g.file).slice(0, 60), text: (g.text || '').slice(0, 100), s: Number((g.s ?? 0).toFixed(3)) })
  out.sort((a, b) => b.s - a.s)
  try { graphEdgesAppend(query, out.slice(0, 4).map(x => ({ file: x.file, s: x.s }))) } catch { }
  console.log(JSON.stringify({ query, agent: agentArg || '全脑', ms: Date.now() - t0, hits: out.slice(0, 12) }))
}
// ②关联边自积累:每次检索把"查询词→命中文件"写成图谱边(graph.jsonl),graphRecall 未来据此联想(用得越多图越厚)
function graphEdgesAppend(q, hits) {
  try {
    const out = hits.map(h => JSON.stringify({ a: String(q).slice(0, 40), rel: '召回', b: h.file, w: Number(Number(h.s ?? 0).toFixed(3)), at: new Date().toISOString(), source: 'kb_search' })).join('\n')
    if (out) appendFileSync(WS + '/knowledge/graph.jsonl', out + '\n')
  } catch { }
}

// ---- 分片索引 v2(2026-10-15):元数据 jsonl + 二进制向量 bin,按片加载 ----
// v2: .kb-index.shard-<NNN>.jsonl(元数据+文本,无v) + .kb-index.shard-<NNN>.bin(float32 LE,第i块→bin[i*512,(i+1)*512))
//     + .kb-shards.json 清单(片号→块数)。search 逐片 load→score→释放,不全量驻留内存。
const SHARD_SIZE = 2000 // 每片块数
const KB_DIM = 512 // bge-small-zh 维度
function shardPaths(n, agent = KB_AGENT) {
  const nn = String(n).padStart(3, '0')
  return { jsonl: `${kbScope(agent).dir}/.kb-index.shard-${nn}.jsonl`, bin: `${kbScope(agent).dir}/.kb-index.shard-${nn}.bin` }
}
function isNewKb(agent = KB_AGENT) { return existsSync(kbScope(agent).shards) }
function loadShardsManifest(agent = KB_AGENT) { try { return JSON.parse(readFileSync(kbScope(agent).shards, 'utf8')) } catch { return null } }
function loadShardRows(n, agent = KB_AGENT) {
  const p = shardPaths(n, agent).jsonl
  const rows = []
  if (!existsSync(p)) return rows
  for (const l of readFileSync(p, 'utf8').split('\n')) if (l.trim()) { try { rows.push(JSON.parse(l)) } catch { } }
  return rows
}
/** 读一片的向量 bin 为 Float32Array(仅单片,用完即弃) */
function loadShardVecs(n, count, agent = KB_AGENT) {
  const p = shardPaths(n, agent).bin
  if (!existsSync(p)) return null
  const buf = readFileSync(p)
  if (buf.length < count * KB_DIM * 4) return null
  // 整块 memcpy→Float32Array 视图(原生转换,比逐个 readFloatLE 快一个量级)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + count * KB_DIM * 4)
  return new Float32Array(ab)
}
/** 全库元数据(无向量),供邻块扩展/mentions 计数;新格式按片拼,旧格式直接读 */
function kbAllMeta(agent = KB_AGENT) {
  if (isNewKb(agent)) {
    const man = loadShardsManifest(agent)
    const rows = []
    let _vi = 0 // 全局行号(1029 today 妹妹令:增量重写时按行号回填旧向量)
    for (const s of man.shards) { const rs = loadShardRows(s.n, agent); for (const r of rs) { r._vi = _vi++; } rows.push(...rs) }
    return rows
  }
  return loadIndexAt(kbScope(agent).index)
}
/** 给全部块打余弦分:新格式逐片加载 bin(内存纪律:单片驻留),旧格式用行内 v 数组 */
// 传 catF 过滤器时,元数据行不匹配的块直接跳过(向量 bin 行号对齐,靠 skip 保持索引一致)
async function kbScoreAll(qv, catF, agent = KB_AGENT) {
  const qn = Math.sqrt(qv.reduce((s, x) => s + x * x, 0)) || 1
  if (isNewKb(agent)) {
    const man = loadShardsManifest(agent)
    const out = []
    for (const s of man.shards) {
      const rows = loadShardRows(s.n, agent)
      const vecs = loadShardVecs(s.n, rows.length, agent)
      if (!vecs) throw new Error(`shard ${s.n} 向量 bin 缺失或尺寸不符,请重跑 migrate/index`)
      for (let i = 0; i < rows.length; i++) {
        if (catF && !catF(rows[i])) continue // 分类过滤:不匹配的块不参与打分
        let dot = 0, n = 0
        for (let d = 0; d < KB_DIM; d++) { const v = vecs[i * KB_DIM + d]; dot += v * qv[d]; n += v * v }
        out.push({ r: rows[i], s: dot / ((Math.sqrt(n) || 1) * qn) })
      }
      // vecs 出片即弃,下一片重新加载——内存占用恒为单片
    }
    out.sort((a, b) => b.s - a.s)
    return out
  }
  // 旧格式兼容路径:行内 v 数组
  const rows = loadIndexAt(kbScope(agent).index)
  return rows.filter((r) => !catF || catF(r)).map((r) => {
    let dot = 0, n = 0
    for (let i = 0; i < r.v.length; i++) { dot += r.v[i] * qv[i]; n += r.v[i] * r.v[i] }
    return { r, s: dot / ((Math.sqrt(n) || 1) * qn) }
  }).sort((a, b) => b.s - a.s)
}
/** 写分片格式:行(含v)→若干 jsonl(去v)+bin,先写 .tmp 再改名,清单最后落盘 */
async function writeSharded(rows, agent = KB_AGENT, oldBins = null) {
  const fsx = require('node:fs')
  const dir = kbScope(agent).dir
  try { mkdirSync(dir, { recursive: true }) } catch { }
  const shards = []
  const nShards = Math.max(1, Math.ceil(rows.length / SHARD_SIZE))
  for (let s = 0; s < nShards; s++) {
    const part = rows.slice(s * SHARD_SIZE, (s + 1) * SHARD_SIZE)
    const { jsonl, bin } = shardPaths(s, agent)
    const wt = fsx.createWriteStream(jsonl + '.tmp')
    const bins = []
    for (const r of part) {
      const { v, _vi, ...rest } = r
      wt.write(JSON.stringify(rest) + '\n')
      const b = Buffer.alloc(KB_DIM * 4)
      let vec = v
      if (!vec && _vi !== undefined && oldBins) {
        const ob = oldBins[Math.floor(_vi / SHARD_SIZE)]
        if (ob) { const off = (_vi % SHARD_SIZE) * KB_DIM * 4; if (ob.length >= off + KB_DIM * 4) vec = ob.subarray(off, off + KB_DIM * 4) }
      }
      for (let i = 0; i < KB_DIM; i++) b.writeFloatLE((vec && vec[i]) || 0, i * 4)
      bins.push(b)
    }
    await new Promise((r) => wt.end(r))
    fsx.renameSync(jsonl + '.tmp', jsonl)
    fsx.writeFileSync(bin, Buffer.concat(bins))
    shards.push({ n: s, chunks: part.length, jsonlBytes: statSync(jsonl).size, binBytes: statSync(bin).size })
  }
  const man = { version: 2, dim: KB_DIM, shardSize: SHARD_SIZE, total: rows.length, builtAt: new Date().toISOString(), shards }
  // 分类统计:cat→块数 与 cat/sub→块数,写入清单(供 cats 命令与外部路由查询)
  const cats = {}, subs = {}
  for (const r of rows) {
    const c = r.cat || catOf(r.file || '').cat
    cats[c] = (cats[c] || 0) + 1
    const s2 = r.sub || catOf(r.file || '').sub
    if (s2) subs[`${c}/${s2}`] = (subs[`${c}/${s2}`] || 0) + 1
  }
  man.cats = cats; man.subs = subs
  // 自检闸(1029 today 妹妹令):任何片 chunks>0 却全零向量=回填失败,报错拒绝落盘——这病藏了半个月就是因为没这道闸
  let zeroShards = []
  for (const s of shards) {
    const b = fsx.readFileSync(shardPaths(s.n, agent).bin)
    let nz = 0
    for (let i = 0; i < s.chunks; i++) { for (let d = 0; d < KB_DIM; d++) if (b.readFloatLE((i * KB_DIM + d) * 4) !== 0) { nz++; break } }
    if (s.chunks > 0 && nz === 0) zeroShards.push(s.n)
  }
  if (zeroShards.length) throw new Error('自检失败: ' + zeroShards.join(',') + ' 片全零向量(旧 bin 回填缺失),拒绝落盘清单')
  writeFileSync(kbScope(agent).shards, JSON.stringify(man))
  return man
}
/** migrate:旧单文件索引(含v)→分片+bin;失败自动回滚改名,不留半态(只针对根库) */
async function cmdMigrate() {
  const S = kbScope('')
  if (existsSync(S.shards)) { console.log('[kb] 根库已是分片 v2 格式,无需迁移'); return }
  if (!existsSync(S.index)) { console.log('[kb] 未找到旧索引 ' + S.index); return }
  const t0 = Date.now()
  const rows = []
  for (const l of readFileSync(S.index, 'utf8').split('\n')) if (l.trim()) { try { rows.push(JSON.parse(l)) } catch { } }
  if (!rows.length || !rows[0].v) { console.log('[kb] 旧索引无 v 向量字段,中止(不改动任何文件)'); return }
  try {
    const man = await writeSharded(rows, '')
    renameSync(S.index, S.legacy) // 旧索引改名保留,可回滚
    console.log(`[kb] migrate done in ${Date.now() - t0}ms: ${man.total} chunks → ${man.shards.length} shards (每片${SHARD_SIZE}块)`)
    console.log(`[kb] 旧索引保留为 ${S.legacy},回滚: 删 .kb-shards.json 与 shard 文件后 rename 回原名`)
  } catch (e) {
    // 回滚:删除本次写出的所有 shard 文件与清单,旧索引原样不动
    try {
      const man = loadShardsManifest('')
      if (man) for (const s of man.shards) { const p = shardPaths(s.n, ''); try { unlinkSync(p.jsonl) } catch { } try { unlinkSync(p.bin) } catch { } }
      try { unlinkSync(S.shards) } catch { }
    } catch { }
    console.error('[kb] migrate 失败,已回滚删除新文件,旧索引原样保留:', e.message)
    process.exit(1)
  }
}

const SKIP_DIRS = new Set(['node_modules', '.hf-cache', 'plugins', '.git', 'tmp', 'attachment', 'attachments'])
const INCLUDE_DIRS = ['', 'knowledge', 'memory', 'learning', 'self'] // 1029 owner 令:工作区原始日记(self/90-日记/)入索引
const MAX_FILE_BYTES = 600 * 1024

function included(rel) {
  if (rel.startsWith('inbox/')) return !rel.slice(6).includes('/') && rel.endsWith('.md')
  if (!rel.includes('/')) return true
  return INCLUDE_DIRS.some((d) => d && (rel === d || rel.startsWith(d + '/')))
}
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    const rel = relative(WS, p).replace(/\\/g, '/')
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (rel && !included(rel))) continue
      yield* walk(p)
    } else if (e.name.endsWith('.md') && !e.name.startsWith('.') && statSync(p).size <= MAX_FILE_BYTES) {
      // 刀三:专属目录只进对应 agent 的库(--agent X 收 X 专属+公共;默认根库不收任何专属)
      const own = agentOwnDir(rel)
      if (own && own !== KB_AGENT) continue
      yield p
    }
  }
}
function chunk(text, size = 600, overlap = 100) {
  const paras = text.split(/\n\n+/).filter((p) => p.trim())
  const chunks = []
  let cur = ''
  for (const p of paras) {
    if (cur.length + p.length > size && cur) { chunks.push(cur); cur = cur.slice(-overlap) + '\n' + p }
    else cur = cur ? cur + '\n' + p : p
    while (cur.length > size * 2) { chunks.push(cur.slice(0, size * 2)); cur = cur.slice(size * 2 - overlap) }
  }
  if (cur.trim()) chunks.push(cur)
  return chunks
}
async function embed(inputs) {
  const res = await fetch(EMBED_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'bge-small-zh', input: inputs }) })
  if (!res.ok) throw new Error(`embed server ${res.status}: ${await res.text()}`)
  const j = await res.json()
  return j.data.map((d) => d.embedding)
}
async function embedBatch(inputs, size = 32) {
  const out = []
  for (let i = 0; i < inputs.length; i += size) {
    for (let a = 1; ; a++) {
      try { out.push(...await embed(inputs.slice(i, i + size))); break }
      catch (e) { if (a >= 3) throw e; await new Promise((r) => setTimeout(r, 1500 * a)) }
    }
  }
  return out
}
function loadManifest(agent = KB_AGENT) { try { return JSON.parse(readFileSync(kbScope(agent).manifest, 'utf8')) } catch { return {} } }
function saveManifest(m, agent = KB_AGENT) {
  try { mkdirSync(kbScope(agent).dir, { recursive: true }) } catch { }
  writeFileSync(kbScope(agent).manifest, JSON.stringify(m))
}
/** 旧单文件索引读取(迁移/兼容路径) */
function loadIndexAt(path) {
  const rows = []
  if (!existsSync(path)) return rows
  for (const l of readFileSync(path, 'utf8').split('\n')) if (l.trim()) rows.push(JSON.parse(l))
  return rows
}

async function cmdIndex() {
  if (!isNewKb() && existsSync(kbScope(KB_AGENT).index)) { console.log('[kb] 检测到旧格式单文件索引,请先执行: node kb.cjs migrate'); return }
  const mf = loadManifest()
  const old = isNewKb() ? kbAllMeta() : []
  const byFile = new Map()
  for (const r of old) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r) }
  const files = [...walk(WS)]
  console.log(`[kb] scanning ${files.length} md files (${old.length} chunks in index${KB_AGENT ? `, agent=${KB_AGENT} 专属库` : ', 根公共库'})`)
  let added = 0, kept = 0
  const keepFiles = new Set()
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi]
    const rel = relative(WS, f).replace(/\\/g, '/')
    keepFiles.add(rel)
    const st = statSync(f)
    const prev = mf[rel]
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && byFile.has(rel)) { kept++; continue }
    byFile.delete(rel) // 变更/新文件:旧块作废
    const chunks = chunk(readFileSync(f, 'utf8'))
    const vecs = await embedBatch(chunks.map((c, i) => `【${rel} 第${i + 1}段】\n${c}`))
    byFile.set(rel, chunks.map((c, i) => ({ file: rel, chunk: i + 1, of: chunks.length, text: c, v: vecs[i], ...catOf(rel) })))
    mf[rel] = { mtime: st.mtimeMs, size: st.size, chunks: chunks.length }
    added++
    if (added % 20 === 0) {
      console.log(`[kb]   ${fi + 1}/${files.length} processed (${added} changed)`)
      saveManifest(mf)
    }
  }
  for (const rel of [...byFile.keys()]) if (!keepFiles.has(rel)) { byFile.delete(rel); delete mf[rel] }
  const rows = [...byFile.values()].flat()
  // 分片格式检查只约束根库(专属库首建时清单尚未落盘,writeSharded 负责创建)
  if (!isNewKb() && !KB_AGENT) throw new Error('kb index 写入要求分片格式,请先 migrate')
  // 重写前先读旧分片 bin 进内存(writeSharded 会覆盖旧文件,回填必须先取)
  let oldBins = null
  if (isNewKb()) { try { oldBins = loadShardsManifest().shards.map(s => { try { return readFileSync(shardPaths(s.n).bin) } catch { return null } }) } catch { oldBins = null } }
  const man = await writeSharded(rows, KB_AGENT, oldBins) // 新格式:分片 jsonl(无v) + bin(向量,旧行按 _vi 回填)
  saveManifest(mf)
  const totalBytes = man.shards.reduce((s, x) => s + x.jsonlBytes + x.binBytes, 0)
  console.log(`[kb] index done: ${added} changed, ${kept} unchanged, ${rows.length} chunks total → ${man.shards.length} shards, ${((totalBytes) / 1048576).toFixed(1)} MB${KB_AGENT ? ` (agent=${KB_AGENT})` : ''}`)
}

// 第四路:图边召回(蜂群图谱.jsonl 邻域,带边权重)
function graphRecall(query, top = 3) {
  try {
    const gp = WS + '/knowledge/graph.jsonl'
    if (!fs.existsSync(gp)) return []
    const rows = fs.readFileSync(gp, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    const hits = rows.filter(r => JSON.stringify(r).includes(query)).slice(0, top)
    return hits.map(r => ({ id: r.id || r.a, text: '图: ' + r.a + ' -' + r.rel + '→ ' + r.b + ' [' + (r.from||'') + ']', w: 0.8 }))
  } catch { return [] }
}

// 解析 argv 里的 --cat/--sub/--agent 可选过滤参数,返回 { query, cat, sub, agent }
function parseSearchArgs(args) {
  const q = [], f = { cat: '', sub: '', agent: '' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cat' && args[i + 1]) f.cat = args[++i]
    else if (args[i] === '--sub' && args[i + 1]) f.sub = args[++i]
    else if (args[i] === '--agent' && args[i + 1]) f.agent = args[++i]
    else q.push(args[i])
  }
  return { query: q.join(' '), cat: f.cat, sub: f.sub, agent: f.agent }
}

async function cmdSearch(query, top = 6, filter = {}) {
  const t0 = Date.now()
  const agentArg = filter.agent || ''
  const scopes = agentArg ? ['', agentArg] : [''] // 专属检索=专属库+公共根库合并;默认只查根库(不含任何专属)
  try { hitlogRec({ t: query.slice(0, 40), at: Date.now(), src: 'search', cat: filter.cat || '', sub: filter.sub || '', agent: agentArg }) } catch { }
  const [qv] = await embed([query])
  const loadMs = Date.now() - t0
  const now = Date.now()
  const byFile = new Map()
  const allScored = []
  let metaTotal = 0
  for (const sc of scopes) {
    const meta = kbAllMeta(sc)
    metaTotal += meta.length
    if (!meta.length && sc === '' && scopes.length === 1) { console.log('[kb] empty index — run: node kb.cjs index'); return }
    if (!meta.length && sc === agentArg && agentArg) console.log(`[kb] 专属库 knowledge/${agentArg}/ 为空 — 先跑: node kb.cjs index --agent ${agentArg}`)
    for (const r of meta) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r) }
    // 分类过滤器:行有 cat 字段直接比对;老索引无 cat 时降级为按文件路径前缀过滤
    let catF = null
    if (filter.cat || filter.sub) {
      const hasCatField = meta.some((r) => r.cat !== undefined)
      if (hasCatField) {
        catF = (r) => (!filter.cat || r.cat === filter.cat) && (!filter.sub || r.sub === filter.sub)
      } else {
        catF = (r) => {
          const c = catOf(r.file || '')
          return (!filter.cat || c.cat === filter.cat) && (!filter.sub || c.sub === filter.sub)
        }
      }
    }
    const scoredAll = await kbScoreAll(qv, catF, sc)
    const mf = loadManifest(sc)
    for (const { r, s } of scoredAll) {
      // rerank: 时间衰减加成(90天指数,最高+0.1)——新近文档微升,老档不埋没
      let bonus = 0
      const m = mf[r.file]
      if (m && m.mtime) bonus = 0.1 * Math.exp(-((now - m.mtime) / 86400000) / 90)
      allScored.push({ r, s, score: s + bonus })
    }
  }
  // 合并去重:共享条目同时存在于根库与专属库,按 file#chunk 留最高分
  const best = new Map()
  for (const it of allScored) { const k = it.r.file + '#' + it.r.chunk; const p = best.get(k); if (!p || it.score > p.score) best.set(k, it) }
  const scored = [...best.values()].sort((a, b) => b.score - a.score).slice(0, top)
  for (const arr of byFile.values()) arr.sort((a, b) => a.chunk - b.chunk)
  for (const { r, s, score } of scored) {
    console.log(`\n=== ${r.file} #${r.chunk}/${r.of} (cos ${s.toFixed(3)} rerank ${score.toFixed(3)})${agentArg ? ` [agent:${agentArg}]` : ''} ===`)
    // expand: 命中块带出同文件前后邻块(链式查询文件级实现)
    const sibs = byFile.get(r.file) || []
    const prev = sibs.find((x) => x.chunk === r.chunk - 1)
    const next = sibs.find((x) => x.chunk === r.chunk + 1)
    if (prev) console.log(`〔上文 #${prev.chunk}〕${prev.text.slice(0, 100)}…`)
    console.log(r.text.slice(0, 280))
    if (next) console.log(`〔下文 #${next.chunk}〕${next.text.slice(0, 100)}…`)
  }
  console.log(`[kb] ${metaTotal} chunks scored${agentArg ? ` (agent=${agentArg}, 专属+公共)` : ''}, load ${loadMs}ms (embed 时间未计)`)
}

function cmdMentions(term) {
  try { hitlogRec({ t: term.slice(0, 40), at: Date.now(), src: 'mentions' }) } catch { }
  const hits = []
  for (const f of walk(WS)) {
    const rel = relative(WS, f).replace(/\\/g, '/')
    readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (l.includes(term)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`) })
  }
  console.log(`[kb] mentions "${term}": ${hits.length} hits${KB_AGENT ? ` (agent=${KB_AGENT} 专属+公共)` : ''}`)
  for (const h of hits.slice(0, 40)) console.log(h)
  if (hits.length > 40) console.log(`... ${hits.length - 40} more`)
}

/** cats:列出所有类别/子类别及块数(优先读清单缓存,清单无统计则从索引现算) */
function cmdCats() {
  const man = loadShardsManifest()
  let cats = null, subs = null
  if (man && man.cats) { cats = man.cats; subs = man.subs || {} }
  else {
    cats = {}; subs = {}
    for (const r of kbAllMeta()) {
      const c = catOf(r.file || '')
      cats[c.cat] = (cats[c.cat] || 0) + 1
      if (c.sub) subs[`${c.cat}/${c.sub}`] = (subs[`${c.cat}/${c.sub}`] || 0) + 1
    }
  }
  console.log(`[kb] 分类统计${KB_AGENT ? `(agent=${KB_AGENT} 专属库)` : '(根公共库)'}(主类别 → 块数):`)
  for (const [c, n] of Object.entries(cats).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`)
  console.log('[kb] 子类别(knowledge/ 下二级目录 → 块数):')
  for (const [s, n] of Object.entries(subs).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`)
}

function cmdStats() {
  const t0 = Date.now()
  const rows = kbAllMeta()
  const files = new Set(rows.map((r) => r.file))
  const mf = loadManifest()
  if (isNewKb()) {
    const man = loadShardsManifest()
    const binBytes = man.shards.reduce((s, x) => s + x.binBytes, 0)
    const jsonlBytes = man.shards.reduce((s, x) => s + x.jsonlBytes, 0)
    console.log(`[kb] ${rows.length} chunks / ${files.size} files / ${man.shards.length} shards (每片${man.shardSize}块); bin ${(binBytes / 1048576).toFixed(1)} MB + jsonl ${(jsonlBytes / 1048576).toFixed(1)} MB; manifest ${Object.keys(mf).length} entries; meta load ${Date.now() - t0}ms${KB_AGENT ? ` (agent=${KB_AGENT})` : ''}`)
  } else {
    console.log(`[kb] ${rows.length} chunks / ${files.size} files (旧单文件格式); manifest ${Object.keys(mf).length} entries; meta load ${Date.now() - t0}ms${KB_AGENT ? ` (agent=${KB_AGENT})` : ''}`)
  }
}

function cmdTags() {
  const groups = {}
  const recents = []
  for (const f of walk(WS)) {
    const rel = relative(WS, f).replace(/\\/g, '/')
    const m = readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/)
    if (m) for (const t of [...m[1].matchAll(/tags:\s*\[([^\]]*)\]/g)].flatMap((x) => x[1].split(',').map((s) => s.trim()).filter(Boolean))) (groups[t] ||= []).push(rel)
    recents.push({ rel, m: statSync(f).mtimeMs })
  }
  let out = `# 索引_标签(kb tags 自动生成 ${new Date().toISOString().slice(0, 10)})\n\n`
  for (const [t, fl] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) out += `## ${t} (${fl.length})\n` + fl.map((f) => `- [[${f}]]`).join('\n') + '\n\n'
  try { mkdirSync(kbScope().dir, { recursive: true }) } catch { }
  writeFileSync(WS + '/knowledge/索引_标签.md', out)
  recents.sort((a, b) => b.m - a.m)
  writeFileSync(WS + '/knowledge/索引_最近更新.md', `# 索引_最近更新(kb tags 自动生成)\n\n` + recents.slice(0, 20).map((r) => `- ${new Date(r.m).toISOString().slice(0, 16).replace('T', ' ')} [[${r.rel}]]`).join('\n') + '\n')
  console.log(`[kb] 索引_标签.md (${Object.keys(groups).length} tags) + 索引_最近更新.md written`)
}

// ============================================================
// L1 原始会话向量层(2026-10-13 · 原始出处直查):直接索引 D:\dsh-data
// 的 zstd 会话原件(在线会话+隔离区归档),逐帧解压→对话行→回合分块→bge 向量。
// 命中即原始出处(窗口/日期/时间/原文/文件路径),可搜索所有原始会话。
// 命令: sesindex(建索引) sessearch(向量检索) sesmentions(确定性grep)
//       sesstats(状态); presearch 自动并入双路召回。
// 2026-10-27 刀一/二/五:行内 agent 字段(路径推导) + --agent 过滤 + 流式 top-k 内存止血。
// ============================================================
const zlib = require('node:zlib')
const DSH_DATA = process.env.DSH_DATA || process.env.DSH_HOME || ''
const SES_INDEX = WS + '/knowledge/.ses-index.jsonl' // ses 层始终落根 knowledge(公共基础设施,隔离靠行内 agent 字段)
const SES_MANIFEST = WS + '/knowledge/.ses-manifest.json'
const SES_TMP = SES_INDEX + '.tmp'
const SES_BIN = SES_INDEX + '.bin'
const SES_DIM = 512

function listDirs(p) { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] } }

function sidLabel(sid) {
  if (sid.startsWith('qq-dm-')) return '私信'
  if (sid.startsWith('qq-group-')) return '群' + sid.slice(9)
  if (sid.startsWith('dsh-automation')) return '自动化'
  return '子窗'
}

// ---- agent 从文件路径推导（通用规则，无实例特定映射）----
const AGENT_WORKSPACE_MARKS = []
const AGENT_SESSION_OVERRIDES = {}
function agentFromKey(key) {
  const sid = key ? key.split('/').slice(-2)[0] : ''
  for (const [sidPart, a] of Object.entries(AGENT_SESSION_OVERRIDES)) if (sid.includes(sidPart)) return a
  if (key) for (const [mark, a] of AGENT_WORKSPACE_MARKS) if (key.includes(mark)) return a
  if (sid.startsWith('qq-')) return AGENT_NAME // QQ 会话归聊天 agent（可用 KB_AGENT_NAME 配置覆盖，见下）
  return 'host'
}
// 可配置的 agent 名（部署时在 config.json 设 agentName；默认仍为 tongling 保持向后兼容）
const AGENT_NAME = process.env.KB_AGENT_NAME || 'tongling'

/** 枚举全部会话 zstd 原件:在线 + 隔离区;v4 优先 v3 兜底（2026-10-17 alpha.5 P0） */
function* sessionFiles() {
  // 会话根目录：KB_SESSION_ROOTS 环境变量（分号分隔绝对路径）；未配置时退回 <DSH_DATA>/sessions 下全部子目录
  const roots = (process.env.KB_SESSION_ROOTS ? process.env.KB_SESSION_ROOTS.split(';').map(s => s.trim()).filter(Boolean) : [])
  if (roots.length) {
    for (const root of roots) { for (const d of listDirs(root)) { const v4 = root + '/' + d + '/session.v4.jsonl.zstd'; const v3 = root + '/' + d + '/session.v3.jsonl.zstd'; if (existsSync(v4)) yield v4; else if (existsSync(v3)) yield v3 } }
  } else {
    for (const d of listDirs(DSH_DATA + '/sessions')) {
      const v4 = DSH_DATA + '/sessions/' + d + '/session.v4.jsonl.zstd'
      const v3 = DSH_DATA + '/sessions/' + d + '/session.v3.jsonl.zstd'
      if (existsSync(v4)) yield v4
      else if (existsSync(v3)) yield v3
    }
  }
  const q = DSH_DATA + '/session-quarantine'
  for (const hold of listDirs(q)) {
    for (const d of listDirs(q + '/' + hold)) {
      const v4 = q + '/' + hold + '/' + d + '/session.v4.jsonl.zstd'
      const v3 = q + '/' + hold + '/' + d + '/session.v3.jsonl.zstd'
      if (existsSync(v4)) yield v4
      else if (existsSync(v3)) yield v3
    }
  }
}

/** 逐帧解压 zstd(帧魔数 28B52FFD;损坏帧滑过不中断) */
function* zstdFrames(file) {
  const buf = readFileSync(file)
  const u32 = (o) => ((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0)
  const MAGIC = 0xFD2FB528
  let off = 0
  while (off + 4 <= buf.length) {
    if (u32(off) !== MAGIC) { off++; continue }
    let out = null
    try { out = zlib.zstdDecompressSync(buf.subarray(off)) } catch { off++; continue }
    if (out && out.length) yield out.toString('utf8')
    let next = -1
    for (let i = off + 4; i + 4 <= buf.length; i++) { if (u32(i) === MAGIC) { next = i; break } }
    if (next === -1) break
    off = next
  }
}

/** 提取对话行:用户消息(保留时间/发信人原文) + 助手回复;剔系统注入/检索回显/样板尾注 */
function extractRows(jsonl) {
  const rows = []
  for (const l of jsonl.split('\n')) {
    if (!l.trim()) continue
    let j; try { j = JSON.parse(l) } catch { continue }
    const d = j.data || {}
    if (j.type === 'user/message') {
      const c = d.content
      const txt = Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join(' ') : String(c ?? '')
      for (const line of txt.split('\n')) {
        const s = line.trim()
        if (!s || s.length < 2) continue
        if (/^(<system-reminder|Current runtime|Instructions from|The following|A skill is)/.test(s)) continue
        if (/^【(主动|交接卡|自动换血|主窗口注入|戳一戳)/.test(s)) continue
        if (/^\[知识库自动检索|^\[向量检索前置/.test(s)) continue
        if (/^（(要发言就用|要回应就立刻|该回就回|图见附件|当前时段)/.test(s)) continue
        rows.push({ role: 'msg', time: j.time, text: s.slice(0, 500) })
      }
    } else if (j.type === 'assistant/message' && d.message && d.message.role === 'assistant') {
      const c = d.message.content
      const s = (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join(' ') : '').replace(/\s+/g, ' ').trim()
      if (s && s.length >= 2 && !s.startsWith('<') && !s.startsWith('{"')) rows.push({ role: '咱', time: j.time, text: s.slice(0, 400) })
    }
  }
  return rows
}

const CST = (t) => { if (!t) return { date: '?', clock: '?' }; const d = new Date(t + 8 * 3600 * 1000); const s = d.toISOString(); return { date: s.slice(0, 10), clock: s.slice(11, 16) } }

/** 回合分块:一条用户消息开启新块,后续"咱"回复并入,>700字切下一块(刀一:带 agent) */
function chunkTurns(rows, sid, label, key, agent) {
  const chunks = []
  let cur = null
  const flush = () => { if (cur && cur.lines.length) chunks.push(cur); cur = null }
  for (const r of rows) {
    if (r.role === 'msg') flush()
    if (!cur) cur = { lines: [], chars: 0, t0: r.time, t1: r.time }
    cur.lines.push((r.role === '咱' ? '咱: ' : '') + r.text)
    cur.chars += r.text.length
    cur.t1 = r.time
    if (cur.chars > 700) flush()
  }
  flush()
  return chunks.map((c) => {
    const a = CST(c.t0)
    return { key, sid, label, agent: agent || AGENT_NAME, date: a.date, clock: a.clock, t0: c.t0 || 0, t1: c.t1 || 0, text: c.lines.join('\n').slice(0, 900) }
  })
}

/** 旧读法保留给 sesindex 增量建库:读全量行并补 agent(缺字段=路径推导,向后兼容) */
function loadSesIndex() {
  const rows = []
  if (!existsSync(SES_INDEX)) return rows
  for (const l of readFileSync(SES_INDEX, 'utf8').split('\n')) if (l.trim()) {
    try {
      const r = JSON.parse(l)
      if (!r.agent) r.agent = agentFromKey(r.key)
      rows.push(Object.assign(r, { _vi: rows.length }))
    } catch { }
  }
  return rows
}

function loadSesManifest() { try { return JSON.parse(readFileSync(SES_MANIFEST, 'utf8')) } catch { return {} } }
function saveSesManifest(m) { writeFileSync(SES_MANIFEST, JSON.stringify(m)) }

// ---- 刀五:向量 bin 按需读(fd 常开,每次 readSync 恰好 512×4 字节,全库不再驻留内存) ----
function sesVecReader(binPath) {
  if (!existsSync(binPath)) return null
  const fd = openSync(binPath, 'r')
  const size = fstatSync(fd).size
  const buf = Buffer.allocUnsafe(SES_DIM * 4)
  return {
    // 读第 vi 行向量,返回复用 Buffer(读后立刻用完,勿存引用);越界/短读返回 null
    read(vi) {
      const off = vi * SES_DIM * 4
      if (off + SES_DIM * 4 > size) return null
      const n = readSync(fd, buf, 0, SES_DIM * 4, off)
      return n === SES_DIM * 4 ? buf : null
    },
    close() { try { closeSync(fd) } catch { } },
  }
}
// ---- 刀五:大 jsonl 流式逐行(4MB 块读 + StringDecoder 保 UTF-8 边界,不整库载入) ----
function* sesLines(path) {
  const { StringDecoder } = require('node:string_decoder')
  const fd = openSync(path, 'r')
  try {
    const dec = new StringDecoder('utf8')
    const CH = 4 * 1024 * 1024
    const buf = Buffer.alloc(CH)
    let tail = ''
    for (;;) {
      const n = readSync(fd, buf, 0, CH, null)
      if (n <= 0) break
      const data = tail + dec.write(buf.subarray(0, n))
      const lastNL = data.lastIndexOf('\n')
      if (lastNL === -1) { tail = data; continue }
      for (const l of data.slice(0, lastNL).split('\n')) yield l
      tail = data.slice(lastNL + 1)
    }
    const rest = tail + dec.end()
    if (rest) yield rest
  } finally { try { closeSync(fd) } catch { } }
}
/** 行余弦打分(bin 行 float32 LE) */
function sesScoreRow(buf, qv, qn) {
  let dot = 0, n = 0
  for (let d = 0; d < SES_DIM; d++) { const v = buf.readFloatLE(d * 4); dot += v * qv[d]; n += v * v }
  return dot / ((Math.sqrt(n) || 1) * qn)
}
/**
 * 刀五·终版双流对扫(2026-10-27 实测 5.5s→优化):jsonl 逐行流 + bin 4M行块 Float32 视图,
 * agent 用 indexOf 抽取(写侧保证字段存在,text 经 JSON 转义不会伪匹配),不逐行 JSON.parse,
 * 只有超过当前 top 门槛的候选才解析原文。内存 O(块 + top)。
 * 返回 { hits:[{r,s}] 已按分降序, scored, vecMiss, noBin }
 */
function sesStreamTopK(qv, qn, top, agentArg) {
  const fsx = require('node:fs')
  if (!existsSync(SES_BIN)) return { hits: [], scored: 0, vecMiss: 0, noBin: true }
  const ROWB = SES_DIM * 4
  const CHUNK_ROWS = 4096 // 8MB/块
  const binFd = fsx.openSync(SES_BIN, 'r')
  const maxRows = Math.floor(fsx.fstatSync(binFd).size / ROWB)
  const binBuf = Buffer.allocUnsafe(CHUNK_ROWS * ROWB)
  let binRowBase = -1, binBufRows = 0
  const heap = topHeap(top)
  let vi = 0, scored = 0, vecMiss = 0
  const scoreRow = (row) => {
    if (row >= maxRows) return null
    if (row < binRowBase || row >= binRowBase + binBufRows) {
      binRowBase = Math.floor(row / CHUNK_ROWS) * CHUNK_ROWS
      const want = Math.min(CHUNK_ROWS, maxRows - binRowBase)
      const got = want > 0 ? fsx.readSync(binFd, binBuf, 0, want * ROWB, binRowBase * ROWB) : 0
      binBufRows = Math.floor(got / ROWB)
    }
    const f32 = new Float32Array(binBuf.buffer, binBuf.byteOffset + (row - binRowBase) * ROWB, SES_DIM)
    let dot = 0, n = 0
    for (let d = 0; d < SES_DIM; d++) { const v = f32[d]; dot += v * qv[d]; n += v * v }
    return dot / ((Math.sqrt(n) || 1) * qn)
  }
  const threshold = () => (heap.list.length === top ? heap.list[top - 1].s : -1)
  for (const line of sesLines(SES_INDEX)) {
    if (!line.trim()) continue
    let ag = ''
    if (agentArg) {
      const ai = line.indexOf('"agent":"')
      if (ai >= 0) { const e = line.indexOf('"', ai + 9); if (e > ai) ag = line.slice(ai + 9, e) }
      if (ag !== agentArg) { vi++; continue } // 刀二:score 之前过滤;_vi 仍按原文件行序
    }
    const s = scoreRow(vi)
    vi++
    if (s === null) { vecMiss++; continue }
    scored++
    if (s > threshold()) {
      let r; try { r = JSON.parse(line) } catch { continue }
      if (!r.agent) r.agent = ag || agentFromKey(r.key)
      heap.push({ r, s })
    }
  }
  try { fsx.closeSync(binFd) } catch { }
  return { hits: heap.list.sort((a, b) => b.s - a.s), scored, vecMiss, noBin: false }
}
/** 定长 top 堆(k≤8 恒小,插入 O(k)) */
function topHeap(k) {
  const a = []
  return {
    push(it) {
      if (a.length < k) { a.push(it); if (a.length === k) a.sort((x, y) => y.s - x.s); return }
      if (it.s <= a[k - 1].s) return
      a[k - 1] = it
      for (let i = k - 1; i > 0 && a[i].s > a[i - 1].s; i--) { const t = a[i]; a[i] = a[i - 1]; a[i - 1] = t }
    },
    list: a,
  }
}

/** sesindex:全量枚举+增量(mtime/size 未变则跳过);产物 jsonl(文本+agent)+bin(向量) */
const SES_LOCK = SES_INDEX + '.lock'
async function cmdSesIndex() {
  // 单实例锁(2026-10-13):防多实例并发互写索引;25分钟=陈旧接管(正常全量约20分钟)
  try {
    if (existsSync(SES_LOCK)) {
      const age = Date.now() - statSync(SES_LOCK).mtimeMs
      if (age < 25 * 60 * 1000) { console.log('[ses] another sesindex is running (lock fresh), exit'); return }
    }
    writeFileSync(SES_LOCK, String(process.pid))
  } catch { }
  try {
    await cmdSesIndexInner()
  } finally {
    try { unlinkSync(SES_LOCK) } catch { }
  }
}

async function cmdSesIndexInner() {
  const t0 = Date.now()
  const mf = loadSesManifest()
  const old = loadSesIndex()
  const byKey = new Map()
  for (const r of old) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r) }
  const files = [...sessionFiles()]
    .map((f) => ({ f, size: statSync(f).size }))
    .sort((x, y) => y.size - x.size)
    .map((x) => x.f) // 大文件优先(高价值归档先入库,长尾自动化会话殿后)
  console.log(`[ses] scanning ${files.length} session files (${old.length} turns indexed)`)
  let added = 0, kept = 0, empty = 0
  const keepKeys = new Set()
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi]
    const key = f.replace(/\\/g, '/')
    const sid = key.split('/').slice(-2)[0]
    const label = sidLabel(sid)
    const agent = agentFromKey(key) // 刀一:路径推导
    keepKeys.add(key)
    const st = statSync(f)
    const prev = mf[key]
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && byKey.has(key)) { kept++; continue }
    byKey.delete(key)
    let jsonl = ''
    try { for (const part of zstdFrames(f)) jsonl += part + '\n' } catch { }
    const turns = chunkTurns(extractRows(jsonl), sid, label, key, agent)
    if (!turns.length) { mf[key] = { mtime: st.mtimeMs, size: st.size, chunks: 0 }; empty++; saveSesManifest(mf); continue }
    let vecs = null
    for (let attempt = 1; attempt <= 3 && vecs === null; attempt++) {
      try { vecs = await embedBatch(turns.map((c) => `【会话${c.label} ${c.date} ${c.clock}】\n${c.text}`)) }
      catch (e) { console.log(`[ses]   embed fail (attempt ${attempt}/3) ${sid.slice(0, 30)}: ${String(e).slice(0, 80)}`); if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt)) }
    }
    if (vecs === null) { console.log(`[ses]   SKIP(3次embed失败,下轮续跑) ${key}`); empty++; saveSesManifest(mf); continue }
    byKey.set(key, turns.map((c, i) => ({ key: c.key, sid: c.sid, label: c.label, agent: c.agent, date: c.date, clock: c.clock, t0: c.t0, t1: c.t1, text: c.text, v: vecs[i] })))
    mf[key] = { mtime: st.mtimeMs, size: st.size, chunks: turns.length }
    added++
    console.log(`[ses]   ${fi + 1}/${files.length} ${label} ${sid.slice(0, 34)} → ${turns.length} turns`)
    saveSesManifest(mf)
  }
  for (const k of [...byKey.keys()]) if (!keepKeys.has(k)) { byKey.delete(k); delete mf[k] }
  const rows = [...byKey.values()].flat()
  const fsx = require('node:fs')
  const ws = fsx.createWriteStream(SES_TMP)
  const binChunks = []
  // 增量 finalize:旧行(无 v)按 _vi 从旧 bin 按需回填向量(刀五:不再整库载入);新行用刚 embed 的 v
  const rd = old.length ? sesVecReader(SES_BIN) : null
  for (const r of rows) {
    const { v, _vi, ...rest } = r
    ws.write(JSON.stringify(rest) + '\n')
    const b = Buffer.alloc(SES_DIM * 4)
    if (v) for (let i = 0; i < SES_DIM; i++) b.writeFloatLE(v[i] || 0, i * 4)
    else if (_vi !== undefined && rd) { const src = rd.read(_vi); if (src) src.copy(b) }
    binChunks.push(b)
  }
  if (rd) rd.close()
  await new Promise((r) => ws.end(r))
  fsx.renameSync(SES_TMP, SES_INDEX)
  fsx.writeFileSync(SES_BIN, Buffer.concat(binChunks))
  saveSesManifest(mf)
  console.log(`[ses] index done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${added} changed, ${kept} unchanged, ${empty} empty, ${rows.length} turns total → ${SES_INDEX}`)
}

/** sessearch:向量检索全部原始会话(刀五:双流对扫 top-k,内存 O(块+top));命中即原始出处 */
async function cmdSesSearch(query, top = 8, agentArg = '') {
  if (!existsSync(SES_INDEX)) { console.log('[ses] empty index — run: node kb.cjs sesindex'); return }
  try { hitlogRec({ t: query.slice(0, 40), at: Date.now(), src: 'sessearch', agent: agentArg }) } catch { }
  const [qv] = await embed([query])
  const qn = Math.sqrt(qv.reduce((a, x) => a + x * x, 0)) || 1
  const { hits, scored, vecMiss, noBin } = sesStreamTopK(qv, qn, top, agentArg)
  if (noBin) { console.log('[ses] 向量缓存与索引不匹配,重跑: node kb.cjs sesindex'); return }
  for (const { r, s } of hits) {
    console.log(`\n=== [agent:${r.agent}][${r.label}] ${r.sid} ${r.date} ${r.clock} (cos ${s.toFixed(3)}) ===`)
    console.log(r.text.slice(0, 350))
    console.log(`〔出处〕${r.key}`)
  }
  if (vecMiss) console.log(`[ses] 警告: ${vecMiss} 行向量缺失(bin 与 jsonl 不齐),重跑: node kb.cjs sesindex`)
  const mem = process.memoryUsage()
  console.log(`[ses] ${scored} rows scored (agent${agentArg ? '=' + agentArg : '=全部'}), rss ${(mem.rss / 1048576).toFixed(0)} MB`)
}

/** sesmentions:全归档确定性 grep(向量召回的兜底伙伴);刀二:--agent 过滤 */
function cmdSesMentions(term, agentArg = '') {
  let hits = 0, files = 0
  for (const f of sessionFiles()) {
    if (agentArg && agentFromKey(f.replace(/\\/g, '/')) !== agentArg) continue
    files++
    let jsonl = ''
    try { for (const part of zstdFrames(f)) jsonl += part + '\n' } catch { continue }
    for (const l of extractRows(jsonl)) {
      if (l.text.includes(term)) {
        hits++
        if (hits <= 40) {
          const a = CST(l.time)
          console.log(`[${sidLabel(f.split('/').slice(-2)[0])}] ${a.date} ${a.clock} ${l.text.slice(0, 140)}\n  〔出处〕${f.replace(/\\/g, '/')}`)
        }
      }
    }
  }
  console.log(`[ses] mentions "${term}": ${hits} hits${agentArg ? ` (agent=${agentArg}, ${files} files)` : ''}`)
}

function cmdSesStats() {
  const mf = loadSesManifest()
  let total = 0
  const byLabel = {}, byAgent = {}
  for (const line of sesLines(SES_INDEX)) { // 刀五:统计也走流式,不整库载入
    if (!line.trim()) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    total++
    byLabel[r.label] = (byLabel[r.label] || 0) + 1
    const ag = r.agent || agentFromKey(r.key)
    byAgent[ag] = (byAgent[ag] || 0) + 1
  }
  const mem = process.memoryUsage()
  console.log(`[ses] ${total} turns / ${Object.keys(mf).length} session files; byAgent: ${JSON.stringify(byAgent)}; byWindow: ${JSON.stringify(byLabel)}; rss ${(mem.rss / 1048576).toFixed(0)} MB`)
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'index') await cmdIndex()
  else if (cmd === 'migrate') await cmdMigrate()
  else if (cmd === 'search') { const p = parseSearchArgs(args); await cmdSearch(p.query, 6, { cat: p.cat, sub: p.sub, agent: p.agent }) }
  else if (cmd === 'presearch') { // 机器可读·四路召回(kb知识库+ses原始会话+图谱边+召回热度),兼容旧数组格式,静默无命中输出[]
    const empty = '[]'
    const p = parseSearchArgs(args)
    const q = p.query
    const agentArg = p.agent
    const scopes = agentArg ? ['', agentArg] : ['']
    const hasSes = existsSync(SES_INDEX)
    const meta = kbAllMeta('')
    if (!meta.length && !hasSes && !agentArg) { console.log(empty); return }
    try {
      const [qv] = await embed([q])
      const out = []
      if (meta.length || agentArg) {
        // kb 知识库路:专属检索=专属+公共合并去重,默认只查根库;recentBoost=常被想起的微加权(遗忘曲线逆操作)
        const best = new Map()
        for (const sc of scopes) for (const x of await kbScoreAll(qv, null, sc)) { const k = x.r.file + '#' + x.r.chunk; const pv = best.get(k); if (!pv || x.s > pv.s) best.set(k, x) }
        const boosted = [...best.values()].map(x => ({ ...x, s: x.s + recentBoost(x.r.file) })).sort((a, b) => b.s - a.s)
        for (const x of boosted) {
          if (out.length >= 3 || x.s <= 0.35) break
          out.push({ file: x.r.file, text: x.r.text.slice(0, 120) })
        }
        recentMark(boosted.slice(0, 6).map(x => x.r.file)) // 记录本轮被想起的(供下次 recentBoost)
        graphEdgesAppend(q, boosted.slice(0, 3).map(x => ({ file: x.r.file, s: x.s }))) // 关联边自积累
      }
      { // 图谱第四路:实体/关联边召回(graph.jsonl,含历史手工边+检索自积累边)
        for (const g of graphActivate(q, 2).concat(graphRecall(q, 1))) {
          if (out.length >= 8) break
          out.push({ file: '图谱边', text: String(g.text).slice(0, 120) })
        }
      }
      if (hasSes) {
        const qn = Math.sqrt(qv.reduce((s, x) => s + x * x, 0)) || 1
        const { hits, noBin } = sesStreamTopK(qv, qn, 6, agentArg)
        if (!noBin) {
          for (const x of hits) {
            if (out.length >= 6 || x.s <= 0.30) break
            const prov = x.r.key.split('/').slice(-3, -1).join('/')
            out.push({ file: `原始会话[${x.r.label}]${x.r.date.slice(5)} ${x.r.clock}｜${prov}`, text: x.r.text.replace(/\s+/g, ' ').slice(0, 110) })
          }
        }
      }
      try { hitlogRec({ t: q.slice(0, 40), at: Date.now(), src: 'presearch', agent: agentArg, kb: out.filter((o) => !o.file.startsWith('原始会话')).length, ses: out.filter((o) => o.file.startsWith('原始会话')).length }) } catch { }
      console.log(out.length ? JSON.stringify(out) : empty)
    } catch { console.log(empty) }
  }
  else if (cmd === 'brain') await cmdBrain(args.join(' '), parseSearchArgs(args).agent || '')
  else if (cmd === 'forget') await cmdForget(args[0] || '', parseSearchArgs(args).agent || '')
  else if (cmd === 'memstate') cmdMemState()
  else if (cmd === 'sesindex') await cmdSesIndex()
  else if (cmd === 'sessearch') { const p = parseSearchArgs(args); await cmdSesSearch(p.query, 8, p.agent) }
  else if (cmd === 'sesmentions') { const p = parseSearchArgs(args); cmdSesMentions(p.query, p.agent) }
  else if (cmd === 'sesstats') cmdSesStats()
  else if (cmd === 'mentions') { const p = parseSearchArgs(args); cmdMentions(p.query) } // agent 作用域由模块级 KB_AGENT 承接
  else if (cmd === 'stats') cmdStats()
  else if (cmd === 'cats') cmdCats()
  else if (cmd === 'tags') cmdTags()
  else console.error('usage: node kb.cjs <forget|memstate|brain|index|migrate|search [--cat 类别|--sub 子类|--agent <id>]|presearch [--agent <id>]|mentions|stats|cats|tags|sesindex|sessearch [--agent <id>]|sesmentions [--agent <id>]|sesstats> [args]')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
