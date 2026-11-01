import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * dsh-restart-guard — settings page.
 *
 * The bundle is prebuilt into `lib/client.js` by `scripts/build-client.mjs`, so
 * this file is plain JSX with no type annotations.
 */

const NS = 'dsh-restart-guard'
const META = 'dsh-restart-guard-token'

const zh = {
  nav: '重启守护',
  title: '重启守护',
  subtitle: 'DSH Web 起不来时，由一个独立进程做简单判定并介入修复，同时把过程写进你设定的渠道。',
  loading: '正在读取守护状态…',
  refresh: '刷新',
  stale: '页面令牌已失效，请刷新页面。',
  phase: '状态',
  watcher: '监控进程',
  alive: '运行中',
  dead: '未运行',
  port: '端口',
  profile: 'Profile',
  instance: '实例',
  version: '版本',
  outbox: '待补发通知',
  checks: '环境体检',
  hints: '还需要完善',
  noHints: '环境已就绪，没有待办提示。',
  save: '保存',
  saved: '已保存',
  saving: '保存中…',
  actions: '操作',
  repairTitle: 'AI 修复记录',
  repairFix: 'AI 已修复插件文件：',
  repairDisable: 'AI 已禁用启动条目：',
  repairHint: '确认 DSH 能正常启动后，可以还原 AI 的改动；下次重启 DSH 时会重新加载原来的插件。',
  repairUndo: '恢复 AI 修复',
  confirmUndo: '确定还原 AI 对插件文件/启动条目的改动？下次重启后原来的插件会重新加载。',
  testNotify: '发送测试通知',
  pause: '暂停守护',
  resume: '恢复守护',
  reload: '重载配置',
  restart: '重启 DSH',
  rollback: '回滚 patch',
  drill: '模拟崩溃',
  confirmRestart: '这会重启 DSH Web（当前页面会短暂断开）。继续？',
  confirmRollback: '回滚到最近的 cordis.patch.yml 备份并重启？',
  confirmDrill: '模拟崩溃会真的杀掉 DSH 进程，验证守护能否拉起。继续？',
  confirmStop: '停止守护进程？',
  notifySection: '通知渠道',
  webhook: 'Webhook',
  webhookUrl: 'Webhook 地址',
  webhookPreset: '格式',
  webhookEnabled: '启用 Webhook',
  webhookHint: '也可以只把地址放进环境变量 DSH_RESTART_GUARD_WEBHOOK_URL，不写入配置文件。',
  command: '命令',
  commandProgram: '命令（argv 直传，不经过 shell）',
  commandEnabled: '启用命令渠道',
  im: 'IM（dsh-im）',
  imEnabled: '启用 IM 通知',
  imScan: '扫描 dsh-im',
  imScanning: '扫描中…',
  imPickBot: '选择 Bot',
  imPickTarget: '选择 Target',
  imScanHint: '从 dsh-im 读取 bot 与 target；也可继续手填。',
  aiCredentialSource: '密钥来源',
  aiKeyRef: '凭据名（可选）',
  aiBridge: '用外部程序桥接',
  aiBridgeProgram: '桥接程序（stdin 收提示，stdout 回 JSON）',
  imBot: 'botId',
  imTarget: 'targetId（可选：该 bot 只有一个目标时会自动使用）',
  imNoTarget: '这个 bot 还没有投递目标。QQ 只给 botId 不够：先和机器人聊一次，再到 dsh-im 设置里新建目标，然后重新扫描。',
  imHint: '在 设置 → IM Bot 里复制 botId；targetId 由你自定义。dsh-im 不在线时先落盘，等 DSH 回来后补发。',
  aiSection: 'AI 辅助修复',
  aiEnable: '启用 AI 修复（完全权限：AI 可直接改配置、装依赖、重启服务）',
  aiMode: '修复模式',
  aiModeAct: 'act · AI 直接修复（完全权限）',
  aiModeAdvise: 'advise · 只给判定，不执行',
  aiOrder: '尝试顺序',
  aiOrderAgentFirst: '先 dsh 本体（dsh headless），再插件直连',
  aiOrderDirectFirst: '先插件直连，再 dsh 本体',
  aiOrderAgentOnly: '只用 dsh 本体',
  aiOrderDirectOnly: '只用插件直连',
  aiAgent: '允许调用 dsh 本体代理（继承 DSH 的模型凭据与工具权限）',
  aiAgentCommand: 'dsh 本体命令',
  aiAgentTimeout: 'dsh 本体超时（毫秒）',
  aiPreset: '服务商',
  aiEndpoint: '接口地址',
  aiModel: '模型',
  aiKeyEnv: '密钥环境变量名',
  aiTest: '测试 AI',
  aiTesting: '测试中…',
  aiHint: '默认关闭。开启 act 后，AI 以完全权限修复：提示词附带当前环境（端口、宿主、profile、补丁备份、日志路径、监听者、诊断），先试 dsh 本体（dsh headless）再试插件直连，失败才回退到规则阶梯；发送的日志已脱敏，不含环境变量值、令牌、访问地址。advise 模式只返回判定（重试/回滚/等待/人工），不执行动作。',
  watchdogSection: '守护策略',
  maxAttempts: '连续尝试启动次数',
  startupGrace: '启动宽限（毫秒）',
  settle: '访问行后稳定期（毫秒）',
  rollbackToggle: 'YAML 失败时自动回滚 patch',
  respectStop: '尊重主动停止（退出码 0 不拉起）',
  dangerous: '允许危险操作（模拟崩溃）',
  locale: '语言',
  incidents: '最近事件',
  noIncidents: '还没有事件记录。',
  advice: '建议',
  detail: '详情',
  savedIssues: '配置可保存，但以下字段已回退默认值：',
  error: '出错了',
  ok: '正常',
  warn: '注意',
  fail: '异常',
  advanced: '高级',
  showAdvanced: '显示高级设置',
  hideAdvanced: '收起高级设置',
  updatedAt: '更新于',
  acknowledge: '知道了',
  maintenance: '维护窗口',
  maintenanceHint: '维护/升级期间守护不会启动、回滚或终止任何进程。',
  maintenanceUntil: '维护截止',
}

const en = {
  nav: 'Restart guard',
  title: 'Restart guard',
  subtitle: 'When DSH Web will not come back, an independent process diagnoses it, repairs the common cases, and reports to the channel you chose.',
  loading: 'Reading guard state…',
  refresh: 'Refresh',
  stale: 'The page token is stale. Reload the page.',
  phase: 'Phase',
  watcher: 'Watcher',
  alive: 'running',
  dead: 'not running',
  port: 'Port',
  profile: 'Profile',
  instance: 'Instance',
  version: 'Version',
  outbox: 'Queued notifications',
  checks: 'Environment',
  hints: 'Needs attention',
  noHints: 'Everything is ready.',
  save: 'Save',
  saved: 'Saved',
  saving: 'Saving…',
  actions: 'Actions',
  repairTitle: 'AI repair record',
  repairFix: 'AI repaired plugin files:',
  repairDisable: 'AI disabled loader entry:',
  repairHint: 'Once DSH boots cleanly you can undo the AI change; the original plugin is loaded again after the next restart.',
  repairUndo: 'Undo AI repair',
  confirmUndo: 'Restore the files or loader entry changed by the AI repair? The original plugin loads again after the next restart.',
  testNotify: 'Send test notification',
  pause: 'Pause guard',
  resume: 'Resume guard',
  reload: 'Reload config',
  restart: 'Restart DSH',
  rollback: 'Roll back patch',
  drill: 'Simulate crash',
  confirmRestart: 'This restarts DSH Web (this page disconnects briefly). Continue?',
  confirmRollback: 'Restore the latest cordis.patch.yml backup and restart?',
  confirmDrill: 'The crash drill really kills the DSH process to verify recovery. Continue?',
  confirmStop: 'Stop the watcher?',
  notifySection: 'Notifications',
  webhook: 'Webhook',
  webhookUrl: 'Webhook URL',
  webhookPreset: 'Format',
  webhookEnabled: 'Enable webhook',
  webhookHint: 'You can also keep the URL only in DSH_RESTART_GUARD_WEBHOOK_URL instead of the config file.',
  command: 'Command',
  commandProgram: 'Program (argv, no shell)',
  commandEnabled: 'Enable command channel',
  im: 'IM (dsh-im)',
  imEnabled: 'Enable IM notifications',
  imScan: 'Scan dsh-im',
  imScanning: 'Scanning…',
  imPickBot: 'Pick a bot',
  imPickTarget: 'Pick a target',
  imScanHint: 'Read bots and targets from dsh-im; manual identifiers still work.',
  aiCredentialSource: 'Key source',
  aiKeyRef: 'Credential ref (optional)',
  aiBridge: 'Bridge through a program',
  aiBridgeProgram: 'Bridge program (prompt on stdin, JSON verdict on stdout)',
  imBot: 'botId',
  imTarget: 'targetId (optional: used automatically when the bot has exactly one target)',
  imNoTarget: 'This bot has no delivery target yet. A QQ bot id alone is not enough: message the bot once, create a target in dsh-im, then rescan.',
  imHint: 'Copy botId from Settings → IM Bot; targetId is yours. If dsh-im is offline the message is queued and replayed when DSH returns.',
  aiSection: 'AI-assisted repair',
  aiEnable: 'Enable AI repair (full permissions: the AI may edit configuration, install dependencies and restart the service)',
  aiMode: 'Mode',
  aiModeAct: 'act · let the AI repair directly (full permissions)',
  aiModeAdvise: 'advise · verdict only, no actions',
  aiOrder: 'Order',
  aiOrderAgentFirst: 'DSH agent first (dsh headless), then direct call',
  aiOrderDirectFirst: 'Direct call first, then DSH agent',
  aiOrderAgentOnly: 'DSH agent only',
  aiOrderDirectOnly: 'Direct call only',
  aiAgent: 'Allow the DSH agent (inherits DSH model credentials and tools)',
  aiAgentCommand: 'dsh agent command',
  aiAgentTimeout: 'dsh agent timeout (ms)',
  aiPreset: 'Provider',
  aiEndpoint: 'Endpoint',
  aiModel: 'Model',
  aiKeyEnv: 'API key env var',
  aiTest: 'Test AI',
  aiTesting: 'Testing…',
  aiHint: 'Off by default. In act mode the AI repairs with full permissions: the prompt carries the current environment (port, host, profile, patch backups, log path, listeners, diagnosis), DSH\'s own agent is tried first (dsh headless), then the direct call, and only then the rule ladder. Log text is redacted; no env values, tokens or access URLs are sent. In advise mode the AI only returns retry / rollback-patch / wait / manual and nothing is executed.',
  watchdogSection: 'Watchdog policy',
  maxAttempts: 'Start attempts',
  startupGrace: 'Startup grace (ms)',
  settle: 'Settle after access line (ms)',
  rollbackToggle: 'Roll back the patch on YAML failures',
  respectStop: 'Respect intentional stops (exit code 0)',
  dangerous: 'Allow dangerous actions (crash drill)',
  locale: 'Language',
  incidents: 'Recent incidents',
  noIncidents: 'No incidents recorded.',
  advice: 'Advice',
  detail: 'Detail',
  savedIssues: 'Saved, but these fields fell back to defaults:',
  error: 'Error',
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
  advanced: 'Advanced',
  showAdvanced: 'Show advanced settings',
  hideAdvanced: 'Hide advanced settings',
  updatedAt: 'updated',
  acknowledge: 'Got it',
  maintenance: 'Maintenance window',
  maintenanceHint: 'During maintenance/upgrade the guard will not start, roll back or kill anything.',
  maintenanceUntil: 'Maintenance until',
}

const PRESETS = ['generic', 'feishu', 'wecom', 'dingtalk', 'slack', 'telegram', 'discord', 'ntfy', 'healthchecks']

function readToken() {
  if (typeof document === 'undefined') return ''
  const element = document.querySelector(`meta[name="${META}"]`)
  return element ? element.getAttribute('content') || '' : ''
}

async function api(path, init) {
  const token = readToken()
  const response = await fetch(`api/restart-guard/${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-restart-guard-token': token,
      ...(init && init.headers ? init.headers : {}),
    },
    credentials: 'same-origin',
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`)
  }
  return payload
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px 8px' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
  h1: { fontSize: 18, fontWeight: 600, margin: 0 },
  subtitle: { margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.6, opacity: 0.72, maxWidth: 640 },
  card: { border: '1px solid rgba(127,127,127,0.22)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
  cardTitle: { fontSize: 13, fontWeight: 600, margin: 0, letterSpacing: '0.01em' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 10 },
  stat: { border: '1px solid rgba(127,127,127,0.16)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 },
  statLabel: { fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.04em' },
  statValue: { fontSize: 13, fontWeight: 600, wordBreak: 'break-all' },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  label: { fontSize: 12, opacity: 0.75, width: 140, flexShrink: 0 },
  input: { flex: '1 1 220px', minWidth: 160, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', fontSize: 12.5 },
  button: { padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12.5 },
  primary: { padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.14)', color: 'inherit', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  danger: { padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(200,60,60,0.5)', background: 'rgba(200,60,60,0.08)', color: 'inherit', cursor: 'pointer', fontSize: 12.5 },
  badge: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 999, fontSize: 11.5, border: '1px solid rgba(127,127,127,0.3)' },
  dot: { width: 7, height: 7, borderRadius: 999, display: 'inline-block' },
  hint: { display: 'flex', gap: 10, padding: '9px 10px', borderRadius: 8, border: '1px solid rgba(127,127,127,0.2)', fontSize: 12.5, lineHeight: 1.55 },
  check: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, padding: '3px 0' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  error: { color: '#c0392b', fontSize: 12.5 },
  ok: { color: '#1e8e3e' },
  warn: { color: '#b7791f' },
  muted: { opacity: 0.65, fontSize: 12 },
}

function Badge({ tone, children }) {
  const color = tone === 'ok' ? '#1e8e3e' : tone === 'warn' ? '#b7791f' : tone === 'fail' ? '#c0392b' : '#8a8f98'
  return (
    <span style={styles.badge}>
      <span style={{ ...styles.dot, background: color }} />
      {children}
    </span>
  )
}

function Field({ label, children }) {
  return (
    <div style={styles.row}>
      <span style={styles.label}>{label}</span>
      {children}
    </div>
  )
}

export function Card({ t }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState(null)
  const [advanced, setAdvanced] = useState(false)
  const [incidents, setIncidents] = useState([])
  const [aiResult, setAiResult] = useState('')
  const [imInfo, setImInfo] = useState(null)
  const [imBusy, setImBusy] = useState(false)
  const loadedAt = useRef(0)

  const load = useCallback(async () => {
    try {
      const payload = await api('state', { method: 'GET' })
      setState(payload)
      loadedAt.current = Date.now()
      setError('')
      setDraft((current) => current ?? snapshot(payload.config))
    } catch (failure) {
      setError(String(failure.message || failure))
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 15000)
    return () => clearInterval(timer)
  }, [load])

  const act = useCallback(
    async (action, extra) => {
      setBusy(action)
      setNotice('')
      try {
        const payload = await api('action', { method: 'POST', body: JSON.stringify({ action, ...(extra || {}) }) })
        setNotice(`${action} → ${payload.requestId || 'ok'}`)
        setTimeout(load, 800)
      } catch (failure) {
        setError(String(failure.message || failure))
      } finally {
        setBusy('')
      }
    },
    [load],
  )

  const save = useCallback(async () => {
    if (!draft) return
    setBusy('save')
    setNotice('')
    try {
      const payload = await api('config', { method: 'POST', body: JSON.stringify({ patch: draft }) })
      setState((current) => (current ? { ...current, config: payload.config } : current))
      setDraft(snapshot(payload.config))
      const issues = payload.issues && payload.issues.length ? ` ${t('savedIssues')} ${payload.issues.join('; ')}` : ''
      setNotice(t('saved') + issues)
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy('')
    }
  }, [draft, t])

  const refreshDoctor = useCallback(async () => {
    setBusy('doctor')
    try {
      const payload = await api('doctor', { method: 'GET' })
      setState((current) => (current ? { ...current, doctor: payload } : current))
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy('')
    }
  }, [])

  const scanIm = useCallback(async () => {
    setImBusy(true)
    try {
      const info = await api('im', { method: 'GET' })
      setImInfo(info || { available: false, reason: 'no response' })
    } catch (failure) {
      setImInfo({ available: false, reason: String(failure.message || failure) })
    } finally {
      setImBusy(false)
    }
  }, [])

  const imBots = imInfo && Array.isArray(imInfo.bots) ? imInfo.bots : []
  const imTargets = imInfo && imInfo.targets && imInfo.bots ? imInfo.targets[draft.notify.im.botId] || [] : []

  const testAi = useCallback(async () => {
    setBusy('ai-test')
    setAiResult('')
    try {
      const payload = await api('ai-test', { method: 'POST', body: '{}' })
      if (payload.ok) {
        setAiResult(`${payload.verdict.action} (${payload.verdict.confidence}) — ${payload.verdict.reason}`)
      } else {
        setAiResult(`${payload.error}${payload.keyEnv ? ` (${payload.keyEnv})` : ''}`)
      }
    } catch (failure) {
      setAiResult(String(failure.message || failure))
    } finally {
      setBusy('')
    }
  }, [])

  const loadIncidents = useCallback(async () => {
    try {
      const payload = await api('incidents', { method: 'GET' })
      setIncidents(payload.incidents || [])
    } catch {
      /* incidents are optional */
    }
  }, [])

  useEffect(() => {
    loadIncidents()
  }, [loadIncidents])

  const doctor = state && state.doctor
  const hints = doctor && doctor.hints ? doctor.hints : []
  const watcher = state && state.watcher ? state.watcher : { alive: false }
  const guardState = state && state.state ? state.state : null
  const phase = guardState && guardState.phase ? guardState.phase : 'unknown'
  const tone = watcher.alive ? (phase === 'manual' ? 'warn' : 'ok') : 'fail'

  const update = useCallback((path, value) => {
    setDraft((current) => {
      if (!current) return current
      const next = JSON.parse(JSON.stringify(current))
      const parts = path.split('.')
      let cursor = next
      for (let index = 0; index < parts.length - 1; index += 1) {
        if (typeof cursor[parts[index]] !== 'object' || cursor[parts[index]] === null) cursor[parts[index]] = {}
        cursor = cursor[parts[index]]
      }
      cursor[parts[parts.length - 1]] = value
      return next
    })
  }, [])

  const confirmThen = useCallback(
    (message, action, extra) => {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(message)) return
      act(action, extra)
    },
    [act],
  )

  const presetOptions = useMemo(() => PRESETS.map((preset) => <option key={preset} value={preset}>{preset}</option>), [])

  if (!state) {
    return (
      <div style={styles.root}>
        <div style={styles.h1}>{t('title')}</div>
        <div style={styles.muted}>{error || t('loading')}</div>
      </div>
    )
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.h1}>{t('title')}</h1>
          <p style={styles.subtitle}>{t('subtitle')}</p>
        </div>
        <div style={styles.row}>
          <Badge tone={tone}>{watcher.alive ? t('alive') : t('dead')}</Badge>
          <button style={styles.button} onClick={load} disabled={busy === 'load'}>
            {t('refresh')}
          </button>
        </div>
      </div>

      {error ? <div style={styles.error}>{t('error')}: {error}</div> : null}
      {notice ? <div style={styles.muted}>{notice}</div> : null}
      {guardState && guardState.lastError ? <div style={styles.muted}>{guardState.lastError}</div> : null}

      <div style={styles.grid}>
        <Stat label={t('phase')} value={phase} />
        <Stat label={t('port')} value={state.instance ? String(state.instance.port) : '?'} />
        <Stat label={t('profile')} value={state.instance ? state.instance.profile : '?'} />
        <Stat label={t('version')} value={state.version} />
        <Stat label={t('outbox')} value={String(state.outbox ?? 0)} />
        <Stat label={t('updatedAt')} value={guardState && guardState.updatedAt ? new Date(guardState.updatedAt).toLocaleTimeString() : '—'} />
      </div>

      {hints.length > 0 ? (
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>{t('hints')}</h2>
          {hints.map((hint) => (
            <div key={hint.id} style={{ ...styles.hint, borderColor: hint.level === 'error' ? 'rgba(200,60,60,0.4)' : 'rgba(183,121,31,0.4)' }}>
              <span style={{ color: hint.level === 'error' ? '#c0392b' : '#b7791f' }}>●</span>
              <span>{hint.zh && hint.zh.length > 0 ? hint.zh : hint.en}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={styles.muted}>{t('noHints')}</div>
      )}

      <div style={styles.card}>
        <div style={styles.row}>
          <h2 style={{ ...styles.cardTitle, flex: 1 }}>{t('checks')}</h2>
          <button style={styles.button} onClick={refreshDoctor} disabled={busy === 'doctor'}>
            {t('refresh')}
          </button>
        </div>
        {(doctor && doctor.checks ? doctor.checks : []).map((check) => (
          <div key={check.id} style={styles.check}>
            <span style={{ ...styles.mono, width: 104, opacity: 0.7 }}>{check.id}</span>
            <span style={check.level === 'ok' ? styles.ok : check.level === 'warn' ? styles.warn : styles.error}>
              {check.level === 'ok' ? '✓' : check.level === 'warn' ? '!' : '✗'}
            </span>
            <span style={styles.mono}>{check.detail}</span>
          </div>
        ))}
      </div>

      <div style={styles.card}>
        <h2 style={styles.cardTitle}>{t('notifySection')}</h2>
        <Field label={t('webhookEnabled')}>
          <input type="checkbox" checked={!!draft.notify.webhook.enabled} onChange={(event) => update('notify.webhook.enabled', event.target.checked)} />
        </Field>
        <Field label={t('webhookUrl')}>
          <input style={styles.input} value={draft.notify.webhook.url || ''} placeholder="https://…" onChange={(event) => update('notify.webhook.url', event.target.value)} />
        </Field>
        <Field label={t('webhookPreset')}>
          <select style={styles.input} value={draft.notify.webhook.preset} onChange={(event) => update('notify.webhook.preset', event.target.value)}>
            {presetOptions}
          </select>
        </Field>
        <div style={styles.muted}>{t('webhookHint')}</div>
        <Field label={t('commandEnabled')}>
          <input type="checkbox" checked={!!draft.notify.command.enabled} onChange={(event) => update('notify.command.enabled', event.target.checked)} />
        </Field>
        <Field label={t('commandProgram')}>
          <input style={styles.input} value={draft.notify.command.program || ''} placeholder="/usr/local/bin/notify" onChange={(event) => update('notify.command.program', event.target.value)} />
        </Field>
        <Field label={t('imEnabled')}>
          <input type="checkbox" checked={!!draft.notify.im.enabled} onChange={(event) => update('notify.im.enabled', event.target.checked)} />
        </Field>
        <div style={styles.row}>
          <button style={styles.button} onClick={scanIm} disabled={imBusy}>
            {imBusy ? t('imScanning') : t('imScan')}
          </button>
          {imInfo && !imInfo.available ? <span style={styles.muted}>{imInfo.reason}</span> : null}
        </div>
        {imBots.length > 0 ? (
          <Field label={t('imPickBot')}>
            <select style={styles.input} value={draft.notify.im.botId || ''} onChange={(event) => { update('notify.im.botId', event.target.value); update('notify.im.targetId', '') }}>
              <option value="">—</option>
              {imBots.map((bot) => (
                <option key={bot.botId} value={bot.botId}>{bot.channel || bot.botId}{bot.connected ? '' : ' (offline)'}</option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label={t('imBot')}>
          <input style={styles.input} value={draft.notify.im.botId || ''} onChange={(event) => update('notify.im.botId', event.target.value)} />
        </Field>
        {imTargets.length > 0 ? (
          <Field label={t('imPickTarget')}>
            <select style={styles.input} value={draft.notify.im.targetId || ''} onChange={(event) => update('notify.im.targetId', event.target.value)}>
              <option value="">—</option>
              {imTargets.map((target) => {
                const id = String(target.targetId ?? target.id ?? '')
                return <option key={id} value={id}>{target.name || target.title || id}</option>
              })}
            </select>
          </Field>
        ) : null}
        <Field label={t('imTarget')}>
          <input style={styles.input} value={draft.notify.im.targetId || ''} onChange={(event) => update('notify.im.targetId', event.target.value)} />
        </Field>
        {imInfo && draft.notify.im.botId && imTargets.length === 0 ? <div style={styles.warn}>{t('imNoTarget')}</div> : null}
        <div style={styles.muted}>{t('imHint')} {t('imScanHint')}</div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.cardTitle}>{t('aiSection')}</h2>
        <Field label={t('aiEnable')}>
          <input type="checkbox" checked={!!draft.ai.enabled} onChange={(event) => update('ai.enabled', event.target.checked)} />
        </Field>
        <Field label={t('aiMode')}>
          <select style={styles.input} value={draft.ai.mode || 'act'} onChange={(event) => update('ai.mode', event.target.value)}>
            <option value="act">{t('aiModeAct')}</option>
            <option value="advise">{t('aiModeAdvise')}</option>
          </select>
        </Field>
        <Field label={t('aiOrder')}>
          <select style={styles.input} value={draft.ai.order || 'dsh-agent-first'} onChange={(event) => update('ai.order', event.target.value)}>
            <option value="dsh-agent-first">{t('aiOrderAgentFirst')}</option>
            <option value="direct-first">{t('aiOrderDirectFirst')}</option>
            <option value="dsh-agent-only">{t('aiOrderAgentOnly')}</option>
            <option value="direct-only">{t('aiOrderDirectOnly')}</option>
          </select>
        </Field>
        <Field label={t('aiAgent')}>
          <input type="checkbox" checked={draft.ai.dshAgent?.enabled !== false} onChange={(event) => update('ai.dshAgent.enabled', event.target.checked)} />
        </Field>
        <Field label={t('aiAgentCommand')}>
          <input style={styles.input} value={draft.ai.dshAgent?.command || 'dsh'} onChange={(event) => update('ai.dshAgent.command', event.target.value)} />
        </Field>
        <Field label={t('aiAgentTimeout')}>
          <input style={styles.input} type="number" min="10000" step="10000" value={draft.ai.dshAgent?.timeoutMs || 300000} onChange={(event) => update('ai.dshAgent.timeoutMs', Number(event.target.value))} />
        </Field>
        <Field label={t('aiPreset')}>
          <select style={styles.input} value={draft.ai.preset} onChange={(event) => update('ai.preset', event.target.value)}>
            <option value="deepseek">deepseek</option>
            <option value="openai">openai</option>
            <option value="custom">custom</option>
          </select>
        </Field>
        <Field label={t('aiModel')}>
          <input style={styles.input} value={draft.ai.model || ''} placeholder="deepseek-chat" onChange={(event) => update('ai.model', event.target.value)} />
        </Field>
        <Field label={t('aiEndpoint')}>
          <input style={styles.input} value={draft.ai.endpoint || ''} placeholder="https://…/chat/completions" onChange={(event) => update('ai.endpoint', event.target.value)} />
        </Field>
        <Field label={t('aiCredentialSource')}>
          <select style={styles.input} value={draft.ai.credentialSource || 'auto'} onChange={(event) => update('ai.credentialSource', event.target.value)}>
            <option value="auto">auto (env → dsh credentials)</option>
            <option value="env">env only</option>
            <option value="dsh">dsh credentials only</option>
            <option value="none">none</option>
          </select>
        </Field>
        <Field label={t('aiKeyEnv')}>
          <input style={styles.input} value={draft.ai.keyEnv || ''} placeholder="DEEPSEEK_API_KEY" onChange={(event) => update('ai.keyEnv', event.target.value)} />
        </Field>
        <Field label={t('aiKeyRef')}>
          <input style={styles.input} value={draft.ai.keyRef || ''} placeholder="DEEPSEEK_API_KEY" onChange={(event) => update('ai.keyRef', event.target.value)} />
        </Field>
        <Field label={t('aiBridge')}>
          <input type="checkbox" checked={!!draft.ai.bridge?.enabled} onChange={(event) => update('ai.bridge.enabled', event.target.checked)} />
        </Field>
        {draft.ai.bridge?.enabled ? (
          <Field label={t('aiBridgeProgram')}>
            <input style={styles.input} value={draft.ai.bridge?.program || ''} placeholder="/usr/local/bin/ai-bridge" onChange={(event) => update('ai.bridge.program', event.target.value)} />
          </Field>
        ) : null}
        <div style={styles.row}>
          <button style={styles.button} onClick={testAi} disabled={!!busy}>
            {busy === 'ai-test' ? t('aiTesting') : t('aiTest')}
          </button>
          {aiResult ? <span style={styles.muted}>{aiResult}</span> : null}
        </div>
        <div style={styles.muted}>{t('aiHint')}</div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.cardTitle}>{t('watchdogSection')}</h2>
        <Field label={t('maxAttempts')}>
          <input style={styles.input} type="number" min="0" max="5" value={draft.watchdog.maxRestartAttempts} onChange={(event) => update('watchdog.maxRestartAttempts', Number(event.target.value))} />
        </Field>
        <Field label={t('startupGrace')}>
          <input style={styles.input} type="number" min="0" step="1000" value={draft.watchdog.startupGraceMs} onChange={(event) => update('watchdog.startupGraceMs', Number(event.target.value))} />
        </Field>
        <Field label={t('settle')}>
          <input style={styles.input} type="number" min="0" step="500" value={draft.watchdog.settleMs} onChange={(event) => update('watchdog.settleMs', Number(event.target.value))} />
        </Field>
        <Field label={t('rollbackToggle')}>
          <input type="checkbox" checked={!!draft.watchdog.rollbackProfilePatch} onChange={(event) => update('watchdog.rollbackProfilePatch', event.target.checked)} />
        </Field>
        <Field label={t('respectStop')}>
          <input type="checkbox" checked={!!draft.watchdog.respectIntentionalStop} onChange={(event) => update('watchdog.respectIntentionalStop', event.target.checked)} />
        </Field>
        <Field label={t('dangerous')}>
          <input type="checkbox" checked={!!draft.security.dangerousActions} onChange={(event) => update('security.dangerousActions', event.target.checked)} />
        </Field>

        <button style={styles.button} onClick={() => setAdvanced((value) => !value)}>
          {advanced ? t('hideAdvanced') : t('showAdvanced')}
        </button>
        {advanced ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Field label="probeIntervalMs">
              <input style={styles.input} type="number" min="500" step="500" value={draft.watchdog.probeIntervalMs} onChange={(event) => update('watchdog.probeIntervalMs', Number(event.target.value))} />
            </Field>
            <Field label="stalledExitMs">
              <input style={styles.input} type="number" min="1000" step="1000" value={draft.watchdog.stalledExitMs} onChange={(event) => update('watchdog.stalledExitMs', Number(event.target.value))} />
            </Field>
            <Field label="bootLogPath">
              <input style={styles.input} value={draft.logs.bootLogPath || ''} placeholder="/var/log/dsh-web.log" onChange={(event) => update('logs.bootLogPath', event.target.value)} />
            </Field>
          </div>
        ) : null}

        <div style={styles.row}>
          <button style={styles.primary} onClick={save} disabled={busy === 'save'}>
            {busy === 'save' ? t('saving') : t('save')}
          </button>
        </div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.cardTitle}>{t('actions')}</h2>
        <div style={styles.row}>
          <button style={styles.button} onClick={() => act('test-notify')} disabled={!!busy}>
            {t('testNotify')}
          </button>
          <button style={styles.button} onClick={() => act('pause')} disabled={!!busy}>
            {t('pause')}
          </button>
          <button style={styles.button} onClick={() => act('resume')} disabled={!!busy}>
            {t('resume')}
          </button>
          <button style={styles.button} onClick={() => act('reload')} disabled={!!busy}>
            {t('reload')}
          </button>
          <button style={styles.button} onClick={() => confirmThen(t('confirmRestart'), 'restart')} disabled={!!busy}>
            {t('restart')}
          </button>
          <button style={styles.button} onClick={() => confirmThen(t('confirmRollback'), 'rollback')} disabled={!!busy}>
            {t('rollback')}
          </button>
          <button style={styles.danger} onClick={() => confirmThen(t('confirmDrill'), 'simulate-crash')} disabled={!!busy || !draft.security.dangerousActions}>
            {t('drill')}
          </button>
        </div>
        <div style={styles.muted}>{t('maintenanceHint')}</div>
      </div>

      {state.state?.repair ? (
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>{t('repairTitle')}</h2>
          <div style={styles.muted}>
            {state.state.repair.kind === 'fix-plugin'
              ? `${t('repairFix')} ${state.state.repair.entryName} · ${(state.state.repair.changed || []).map((item) => item.file).join(', ')}`
              : `${t('repairDisable')} ${state.state.repair.entryId}`}
          </div>
          <div style={styles.muted}>{t('repairHint')}</div>
          <div style={styles.row}>
            <button style={styles.button} onClick={() => confirmThen(t('confirmUndo'), 'restore-repair')} disabled={!!busy}>
              {t('repairUndo')}
            </button>
          </div>
        </div>
      ) : null}

      <div style={styles.card}>
        <div style={styles.row}>
          <h2 style={{ ...styles.cardTitle, flex: 1 }}>{t('incidents')}</h2>
          <button style={styles.button} onClick={loadIncidents}>
            {t('refresh')}
          </button>
        </div>
        {incidents.length === 0 ? (
          <div style={styles.muted}>{t('noIncidents')}</div>
        ) : (
          incidents.slice(0, 8).map((incident) => (
            <div key={incident.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid rgba(127,127,127,0.16)', paddingTop: 8 }}>
              <div style={styles.row}>
                <Badge tone={incident.resolvedAt ? 'ok' : 'warn'}>{incident.incident || 'unknown'}</Badge>
                <span style={styles.muted}>{incident.startedAt ? new Date(incident.startedAt).toLocaleString() : ''}</span>
                <span style={{ ...styles.muted, flex: 1 }}>{incident.resolvedAt ? '' : t('noIncidents')}</span>
              </div>
              <div style={styles.mono}>{incident.detail || ''}</div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>{value}</span>
    </div>
  )
}

function snapshot(config) {
  return JSON.parse(JSON.stringify(config))
}

export const inject = ['slots', 'locale']

export function apply(ctx) {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-restart-guard: dictionaries')

  try {
    ctx.slots.inject('settings.section', () => {
      try {
        const unregister = ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-restart-guard',
            order: 240,
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
            inject: () => ({ t: ctx.locale.bind(NS) }),
          },
          Card,
        )
        return () => {
          unregister()
        }
      } catch {
        return () => {}
      }
    })
  } catch {
    /* the settings shell is optional; the guard still works without it */
  }
}
