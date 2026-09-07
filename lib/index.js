/**
 * dsh-host-compliance-check v0.4.0
 *
 * 模仿 Trae 的 stop-hook(decision 移交)语义:
 *  - 只在主会话轮次正常结束时触发(agent/turn-stopping);
 *  - 精确收集:实时监听 tools/result(对顶层 write/edit 与 run_code 内嵌子派发
 *    均触发,exec.name/arguments 是真实工具调用),提取本轮 write/edit 的精确
 *    file_path —— 不再回读会话日志、不再正则解析 run_code 源码;
 *  - 本轮确有文件修改且本用户输入尚未提醒过时,不自动派发检查子智能体,
 *    而是往主会话注入一段 notice 形态的 "[AUTO] 需求合规提醒" 提示词
 *    (source.form='notice',summary 一句话;content 带文件清单与自查清单),
 *    turn 因 next-step 注入而继续,由主模型当场自行判断:
 *      直接收尾 / 简要自查 / 阻塞调用 subagent 深查(拿到报告后排除误报、
 *      只做适当改进并说明);
 *  - 子代理/子会话自身不触发(只对主会话),避免嵌套提醒。
 *
 * 与 0.3.x 的差异(0.4.0):
 *  - 收集信源从"会话事件日志 + run_code 源码启发式解析"改为 tools/result
 *    实时精确记录:write/edit 与 run_code 内 tools.write/edit 子派发都经工具
 *    管道 emit tools/result(exec.agent 携带会话),file_path 精确,误报消失;
 *  - 删除 parseRunCodeWritePaths 三通道源码解析 / scanStringLiterals /
 *    splitLines 等启发式层;
 *  - 注入消息由裸 plugin source 改为 notice 形态:source.form='notice' +
 *    summary(≤120 字符,boundContextSummary),不再以 [AUTO] 文本冒充用户输入;
 *  - diag 日志路径改为基于 DSH_HOME 推导(不再硬编码用户目录),默认关闭。
 *
 * 覆盖边界(0.4.0 起只支持"标准模式"写入,不提供源码扫描兜底):
 *  - 顶层 write/edit 工具调用 —— 经工具管道,tools/result 可见;
 *  - run_code 内经 tools.write/edit 子派发的写入 —— 子派发同样经工具管道
 *    (scheduler.finish → tools/result),可见;
 *  - run_code 程序内以 `await import('node:fs')` 等直接读写文件(PTC 裸写,
 *    绕过 tools 绑定)不经过工具管道、不产生 tools/result —— 本插件检测不到,
 *    属已知限制;合规做法是程序内通过 tools.write/edit 完成写入。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'compliance-check'

/** 每用户输入最多提醒一次的检查标记:sessionId -> true */
const remindedSessions = new Map()
/** 本轮(自上次用户输入复位以来)修改文件:sessionId -> Map<path, {inferred:boolean}> */
const turnWritesBySession = new Map()

/** 诊断日志路径:DSH_HOME 环境变量或用户主目录下的 .dsh(不再硬编码用户目录)。 */
function resolveDiagFile() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'compliance-diag.log')
  } catch {
    return undefined
  }
}

/** 校验并规范化配置;非法配置直接抛错(fail loud)。 */
function resolveConfig(config) {
  const cfg = config ?? {}
  const skipPaths = cfg.skipPaths ?? []
  if (!Array.isArray(skipPaths) || !skipPaths.every((re) => re instanceof RegExp || typeof re === 'string')) {
    throw new TypeError('compliance-check: skipPaths 必须是 RegExp/字符串数组')
  }
  return {
    skipRe: skipPaths.map((re) => re instanceof RegExp ? re : new RegExp(re)),
    diag: cfg.diag === true,
  }
}

/** 安全截断:按码点截断,不切断 UTF-16 代理对。 */
export function safeSlice(text, max) {
  if (text.length <= max) return text
  let end = max
  const c = text.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end -= 1
  return text.slice(0, end)
}

/**
 * 从一次工具执行的 arguments 中提取 file_path(兼容字符串/对象两种形态)。
 * write/edit 顶层调用与 run_code 内子派发都走工具管道,tools/result 的
 * exec.arguments 即真实参数。返回 null 表示无有效路径。
 */
export function extractFilePath(args) {
  if (args === null || args === undefined) return null
  let parsed = args
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args) } catch { return null }
  }
  const fp = parsed?.file_path
  return typeof fp === 'string' && fp.length > 0 ? fp : null
}

/**
 * 记录一次成功写入到 per-session 本轮表。精确路径(inferred=false)优先于
 * 推断路径(inferred=true),同路径重复不重复计数。
 */
export function noteTurnWrite(sessionId, path, inferred) {
  if (sessionId === undefined || typeof path !== 'string' || path.length === 0) return
  let map = turnWritesBySession.get(sessionId)
  if (map === undefined) { map = new Map(); turnWritesBySession.set(sessionId, map) }
  const key = path.replace(/\\/g, '/')
  const existing = map.get(key)
  if (existing === undefined) map.set(key, { inferred: inferred === true })
  else if (!inferred) existing.inferred = false // 工具级精确路径优先
}

/** 取某会话本轮修改文件 Map(不删除,供 turn-stopping 合并)。 */
export function sessionTurnWrites(sessionId) {
  return turnWritesBySession.get(sessionId)
}

/** 清除某会话本轮修改记录(复位/销毁时调用)。 */
export function clearSessionTurnWrites(sessionId) {
  if (sessionId !== undefined) turnWritesBySession.delete(sessionId)
}

/**
 * 从会话事件日志兜底提取本轮 write/edit 路径(仅在 tools/result 实时记录
 * 缺失时使用;事件里 tool/call 带 turn,run_code 内子派发 tool/code-dispatch
 * 无 turn,故这里只处理顶层 tool/call 的 write/edit)。
 * 0.4.0 起主路径为 tools/result,此函数保留用于容错回退。
 */
export function collectTurnWritesFromEvents(agent, turn) {
  const files = new Map()
  const session = agent?.session
  let events
  try { events = session?.ownEvents?.() ?? session?.snapshotEvents?.() } catch { events = undefined }
  if (!Array.isArray(events)) return files
  for (const event of events) {
    if (event?.data?.turn !== turn || event.type !== 'tool/call') continue
    const d = event.data
    if (d?.name !== 'write' && d?.name !== 'edit') continue
    const fp = extractFilePath(d.arguments)
    if (fp === null) continue
    const key = fp.replace(/\\/g, '/')
    const existing = files.get(key)
    if (existing === undefined) files.set(key, { inferred: false })
  }
  return files
}

/**
 * 从会话事件流收集全部真实用户消息文本(跳过插件注入与 goal 自动续轮消息),
 * 按时间顺序拼接,用于提示词上下文。超长截断时保留尾部(最新输入)。
 */
export function lastUserMessageText(agent, maxChars) {
  const session = agent?.session
  let events
  // 用户输入历史取全量(snapshotEvents 含 fork 继承前缀),需求上下文更完整
  try { events = session?.snapshotEvents?.() ?? session?.ownEvents?.() } catch { events = undefined }
  if (!Array.isArray(events)) return undefined
  const parts = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const data = event.data
    if (data?.source?.kind !== 'user') continue
    const text = (data.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text.length === 0) continue
    parts.push(text)
  }
  if (parts.length === 0) return undefined
  const joined = parts.join('\n\n')
  if (joined.length <= maxChars) return joined
  return '…(已截断)' + '\n' + safeSlice(joined.slice(-maxChars), maxChars)
}

/**
 * 会话是否为主会话(需要注入提醒的会话)。
 *
 * 注意:不能以 parentSession === undefined 判定 —— DSH 在 GUI 中恢复/续写历史
 * 会话时会创建带 parentSession(继承源会话)的普通会话(delegationDepth 0、
 * 无 origin),它仍是用户直接对话的主会话,必须触发提醒。
 * 真正的子代理会话由 dsh-subagent 创建,header 带 origin:'subagent',这类
 * 会话自身不触发,避免嵌套提醒。
 */
export function isRootSession(session) {
  return session != null && session.header?.origin !== 'subagent'
}

/**
 * 组装注入主会话的提示词正文(content,不含 [AUTO] 前缀文本 —— 前缀语义
 * 由 source.form='notice' 承担)。文件清单 + 自查清单 + 处理引导。
 */
export function buildPromptBody(files, requirement) {
  const fileList = [...files.keys()].map((f) => '- ' + f).join('\n')
  const parts = [
    '本轮修改了文件:',
    fileList,
    '',
    '请做需求合规性自查(对照本轮用户需求与你动手前的分析/计划):',
    '- 需求是否完成?实现是否偏离需求?',
    '- 是否引入新问题或回归?',
    '- 注释、文档、AGENTS.md 等描述性内容是否与实际行为同步?(若存在)',
    '- 测试与回归是否对齐(若存在测试)?',
    '',
    '处理方式由你判断:',
    '- 改动极少且不影响主要路径:简要说明后直接结束即可,不必展开;',
    '- 改动较多或存在疑虑:可在本回合内调用 subagent/subagent_fork 派发只读检查子智能体(阻塞等待其完成后收尾),传入本轮需求与上述文件清单;拿到报告后排除误报(与既定意图无关、基于不完整上下文的意见不必执行),只对确实需要改进的点做适当改进并说明。',
  ]
  if (requirement !== undefined) {
    parts.splice(2, 0, '', '## 用户输入历史(供对照)', requirement)
  }
  return parts.join('\n')
}

/**
 * 组装注入主会话的消息:notice 形态(user 角色,source 带 form:'notice' +
 * summary,模型可见、UI 折叠展示,不冒充用户输入)。
 */
export function buildNoticeMessage({ content, summary }) {
  const source = {
    kind: 'plugin',
    plugin: 'compliance-check',
    form: 'notice',
    summary: typeof summary === 'string' && summary.length > 0 ? summary.slice(0, 120) : '本轮修改了文件,请按需做需求合规自查',
  }
  return createUserMessage({
    content: [{ type: 'text', text: content }],
    source,
  })
}

/** 组装注入主会话的消息(user 角色,source=plugin notice,模型可见)。 */
function resultMessage(text, files) {
  const n = files?.size ?? 0
  const summary = `本轮修改了 ${n} 个文件,请按需做需求合规自查`
  return buildNoticeMessage({ content: text, summary })
}

export function apply(ctx, config) {
  const diagFile = resolveDiagFile()
  const log = (msg) => {
    if (diagFile === undefined) return
    try { appendFileSync(diagFile, new Date().toISOString() + '  [compliance-check] ' + msg + '\n') } catch { /* 忽略 */ }
  }
  const resolved = resolveConfig(config)
  log('apply: v0.4.0 config=' + JSON.stringify(config ?? {}))

  // 会话销毁时清理标记与写入记录
  ctx.on('agent/disposed', (payload) => {
    const sid = payload?.agent?.session?.id
    if (sid !== undefined) {
      remindedSessions.delete(sid)
      clearSessionTurnWrites(sid)
    }
  })

  // ── 用户新输入:复位提醒标记与本轮写入记录(每用户输入最多提醒一次) ──
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    try {
      if (agent !== undefined && Array.isArray(messages)) {
        const sid = agent.session?.id
        const hasUser = messages.some((m) => m?.source?.kind === 'user')
        if (sid !== undefined && hasUser) {
          remindedSessions.delete(sid)
          clearSessionTurnWrites(sid)
        }
      }
    } catch { /* 复位失败静默 */ }
    return next()
  })

  // ── 精确收集:每个工具执行结束(顶层与 run_code 子派发均触发) ──
  // scope-filtered dispatch:按 exec.agent 只收到该 agent 的结果
  ctx.on('tools/result', (exec, result) => {
    try {
      if (exec === undefined || result?.isError) return
      const name = exec.name
      if (name !== 'write' && name !== 'edit') return
      const sid = exec.agent?.session?.id
      if (sid === undefined) return
      const fp = extractFilePath(exec.arguments)
      if (fp === null) return
      // 应用 skipPaths 过滤(如临时目录/锁文件),命中则不记录
      if (resolved.skipRe.length > 0 && resolved.skipRe.some((re) => re.test(fp))) return
      noteTurnWrite(sid, fp, false)
    } catch { /* 单次记录失败不影响其它 */ }
  })

  // ── 轮次结束:注入 notice 提示词,不派发子代理 ──
  ctx.on('agent/turn-stopping', async ({ agent, signal, turn }) => {
    try {
      log('turn-stopping: agent=' + (agent !== undefined) + ' root=' + (agent !== undefined && isRootSession(agent.session)) + ' turn=' + turn + ' sid=' + agent?.session?.id + ' origin=' + agent?.session?.header?.origin)
      // 只对主会话触发
      if (agent === undefined || !isRootSession(agent.session)) return
      const sessionId = agent.session?.id
      if (sessionId === undefined) return
      if (remindedSessions.has(sessionId)) return
      // 主信源:tools/result 实时记录(本用户输入以来)。合并事件日志兜底(顶层
      // tool/call 的 write/edit,兼容实时记录缺失的极端情况)。
      const files = new Map(sessionTurnWrites(sessionId) ?? [])
      for (const [p, v] of collectTurnWritesFromEvents(agent, turn ?? agent.phase?.turn)) {
        if (!files.has(p)) files.set(p, v)
      }
      log('turn-stopping: 收集到文件数=' + files.size)
      if (files.size === 0) return
      remindedSessions.set(sessionId, true) // 先置位,防重入
      // 注入提示词(进 next-step 队列 → 本 turn 继续,主模型当场看到并响应)
      const requirement = lastUserMessageText(agent, 4000)
      const text = buildPromptBody(files, requirement)
      agent.inject(resultMessage(text, files))
      log('turn-stopping: 已注入 notice 提示词')
    } catch (error) {
      log('turn-stopping: 异常 ' + String(error?.message ?? error))
      // 兜底:任何异常都不阻塞 turn 关闭,尝试注入降级提示
      try {
        if (!signal?.aborted && agent !== undefined) {
          const files = new Map(sessionTurnWrites(agent.session?.id) ?? [])
          agent.inject(resultMessage('本轮修改过文件,请按需做需求合规自查。', files))
        }
      } catch { /* 注入失败则静默 */ }
    }
  })
}
