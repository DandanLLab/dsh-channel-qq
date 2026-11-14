// 独立诊断：直连 OneBot WS 调 get_friend_list，看 SnowLuma 到底回什么
import WebSocket from 'ws'

const URL = 'ws://127.0.0.1:3001'
const TOKEN = 'JGfEahcrFU3Uex3yoI_i07dTPS5IFxi3AntUijB_IGA'
const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } })
const t0 = Date.now()
const timer = setTimeout(() => {
  console.log('TIMEOUT after', Date.now() - t0, 'ms — 无响应（挂起）')
  ws.terminate()
  process.exit(2)
}, 12000)
ws.on('error', (e) => { console.log('WS ERROR:', e.message); clearTimeout(timer); process.exit(1) })
ws.on('open', () => {
  console.log('connected in', Date.now() - t0, 'ms')
  ws.send(JSON.stringify({ action: 'get_friend_list', echo: 't1' }))
})
ws.on('message', (buf) => {
  const ms = Date.now() - t0
  try {
    const d = JSON.parse(buf.toString())
    if (d.echo !== 't1') return
    if (d.status === 'failed' || d.retcode !== 0) {
      console.log('FAILED in', ms, 'ms — status:', d.status, 'retcode:', d.retcode, 'message:', d.message ?? d.wording)
    } else {
      const n = Array.isArray(d.data) ? d.data.length : '非数组: ' + typeof d.data
      console.log('OK in', ms, 'ms — 好友数:', n)
      if (Array.isArray(d.data)) console.log('样例:', JSON.stringify(d.data.slice(0, 3)))
    }
    clearTimeout(timer); ws.close(); process.exit(0)
  } catch { /* 非 JSON 心跳等 */ }
})
