/**
 * dsh-channel-qq — 设置页「QQ 设置」区(Client 半边)。
 *
 * 挂在本包 client 入口里（与表情包面板同一模块图），通过
 * slots.inject('settings.section') 注册；数据走 /channel-qq-api
 * （本机回环 only，热改 config 并持久化 settings.json）。
 *
 * 由 build 脚本拼进 lib/meme/client.js 末尾——不要单独加载本文件。
 */
;(function registerQQSettingsSection() {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return
  window.__ModuleLoader__.load({
    id: 'dsh-channel-qq-qq-settings',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      const React = require('react')

      const QQSettingsPanel = () => {
        const h = React.createElement
        const [state, setState] = React.useState(null)
        const [saved, setSaved] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        React.useEffect(() => {
          fetch('/channel-qq-api').then((r) => r.json()).then((j) => setState(j.settings ?? {})).catch(() => setState({}))
        }, [])
        const set = (k, v) => setState((s) => ({ ...(s ?? {}), [k]: v }))
        const save = async () => {
          setBusy(true); setSaved('')
          try {
            const r = await fetch('/channel-qq-api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state ?? {}) })
            const j = await r.json()
            setSaved(j.ok ? '已保存并热生效 ✓' : '保存失败：' + String(j.error ?? '').slice(0, 60))
          } catch (e) { setSaved('保存失败：' + String(e).slice(0, 60)) }
          setBusy(false)
          setTimeout(() => setSaved(''), 4000)
        }
        if (state === null) return h('div', { style: { padding: '12px', color: '#888' } }, 'QQ 设置加载中…')
        const F = (label, k, type, hint) => {
          const v = state[k]
          return h('div', { key: k, style: { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' } },
            h('label', { style: { flex: '0 0 190px', fontSize: 13 } }, label),
            type === 'boolean'
              ? h('input', { type: 'checkbox', checked: v === true, onChange: (e) => set(k, e.target.checked) })
              : h('input', {
                  type: type === 'number' ? 'number' : 'text',
                  value: v ?? '',
                  step: type === 'number' ? 0.05 : undefined,
                  style: { flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #444', background: 'transparent', color: 'inherit' },
                  onChange: (e) => set(k, type === 'number' ? Number(e.target.value) : e.target.value),
                }),
            hint ? h('span', { style: { fontSize: 12, opacity: 0.6, flex: '0 0 40%' } }, hint) : null,
          )
        }
        const h2 = (t) => h('div', { style: { fontWeight: 600, margin: '14px 0 4px', fontSize: 13, opacity: 0.85 } }, t)
        return h('div', { className: 'qq-settings-panel', style: { maxWidth: 760 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
            h('button', {
              onClick: save, disabled: busy,
              style: { padding: '7px 18px', borderRadius: 6, border: 'none', background: busy ? '#555' : '#2f7d4f', color: '#fff', cursor: busy ? 'wait' : 'pointer', fontWeight: 600 },
            }, busy ? '保存中…' : '保存（热生效）'),
            saved ? h('span', { style: { fontSize: 12, opacity: 0.8 } }, saved) : null,
          ),
          h2('聊天触发'),
          F('群聊回复概率 talkValue', 'talkValue', 'number', '0~1，触发门槛'),
          F('必须 @ 才回应 requireMention', 'requireMention', 'boolean', '关=关键词/概率也会接话'),
          h2('称谓（persona）'),
          F('bot 自称 selfName', 'persona.selfName', 'string'),
          F('对主人的称呼 masterName', 'persona.masterName', 'string'),
          F('对群友的称呼 peerName', 'persona.peerName', 'string'),
          F('自称代词 pronoun', 'persona.pronoun', 'string'),
          h2('表情包'),
          F('偷图入库 steal', 'emoji.steal', 'boolean', '主群图片自动收进表情库'),
          F('回帖自动带图 autoSend', 'emoji.autoSend', 'boolean', '按概率给回复配表情'),
          h2('陌生人私聊门控'),
          F('门控开关 dmGate', 'dmGate.enabled', 'boolean', '陌生人待审+主人通知'),
          F('待审通知主人 notifyAdmin', 'dmGate.notifyAdmin', 'boolean'),
          F('给陌生人的统一回复 pendingReply', 'dmGate.pendingReply', 'string'),
        )
      }

      const apply = (ctx) => {
        try {
          const React = require('react')
          const slots = ctx.get && ctx.get('slots')
          if (slots === undefined) return
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'qq-settings', order: 26, label: 'QQ 设置' },
            () => React.createElement(QQSettingsPanel),
          ))
        } catch (e) { /* slots 未就绪：静默（QQ 设置区可后补） */ }
      }

      return module.exports = { apply }
    },
  })
})()
