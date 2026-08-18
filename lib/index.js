
/**
 * dsh-host-compliance-check
 *
 * 迁移自 Trae 的 "结束后检查" hook(PostToolUse + Stop):
 *  - tools/result      ≈ PostToolUse:记录本轮(每个用户输入)修改过的文件及 before/after 内容
 *  - agent/turn-stopping ≈ Stop:轮次要正常结束时,若本轮改过文件且本次用户输入
 *    尚未检查过,则阻塞派发一个需求合规检查子智能体,并把报告注入主会话
 *
 * 语义:
 *  - 子智能体阻塞执行:turn-stopping 中 await 其完成,主会话挂起
 *  - 每个用户输入最多检查一次:用户新消息重置状态,检查后 checked=true
 *  - 无完成标记协议:完成 = 子智能体返回报告
 *  - 防递归:检查子智能体本身加入豁免集,其 turn 结束不触发嵌套检查
 *  - diff 来源:write/edit 的 canonical value(result.value 的 before/after),
 *    嵌套 run_code 内的调用经 parent token 冒泡到顶层;同一文件多次编辑合并为
 *    本轮净 diff(首次 before → 最终 after),随 prompt 注入检查子智能体
 *
 * 配置(resolveConfig):
 *  - watchTools: 记录哪些写工具修改(默认 ['write','edit'])
 *  - skipPaths:  跳过匹配的路径(RegExp/字符串数组)
 *  - providerName: 检查子智能体 provider(默认 'subagent-fork-in-process')
 *  - promptTemplate: 自定义模板,支持 {{requirement}} / {{files}} / {{diff}}
 *  - diffMaxChars: 注入 prompt 的 diff 总字符上限;0 表示不限制(默认)。
 *    极端场景(超大文件整段重写、多文件大改)超出部分截断,并提示可 read 查看全貌。
 *  - diffMaxLinesPerFile: 单个文件的 diff 行数上限;0 表示不限制(默认)
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'compliance-check'

const DEFAULT_WATCH_TOOLS = ['write', 'edit']
const DEFAULT_PROVIDER = 'subagent-fork-in-process'
const REQUIREMENT_MAX_CHARS = 4000
/** 每个 hunk 保留的上下文行数。 */
const DIFF_CONTEXT = 3
/** 行数乘积超过该值时,中间段整体视为替换,避免 LCS 最坏开销。 */
const LCS_LIMIT = 4_000_000

/** 校验并规范化配置;非法配置直接抛错(fail loud)。 */
function resolveConfig(config) {
  const cfg = config ?? {}
  const watchTools = cfg.watchTools ?? DEFAULT_WATCH_TOOLS
  if (!Array.isArray(watchTools) || watchTools.length === 0
    || !watchTools.every((t) => typeof t === 'string' && t.length > 0)) {
    throw new TypeError('compliance-check: watchTools 必须是非空字符串数组')
  }
  const skipPaths = cfg.skipPaths ?? []
  if (!Array.isArray(skipPaths) || !skipPaths.every((re) => re instanceof RegExp || typeof re === 'string')) {
    throw new TypeError('compliance-check: skipPaths 必须是 RegExp/字符串数组')
  }
  const providerName = cfg.providerName ?? DEFAULT_PROVIDER
  if (typeof providerName !== 'string' || providerName.length === 0) {
    throw new TypeError('compliance-check: providerName 必须是非空字符串')
  }
  const diffMaxChars = cfg.diffMaxChars ?? 0
  if (!Number.isInteger(diffMaxChars) || diffMaxChars < 0) {
    throw new TypeError('compliance-check: diffMaxChars 必须是非负整数(0 表示不限制)')
  }
  const diffMaxLinesPerFile = cfg.diffMaxLinesPerFile ?? 0
  if (!Number.isInteger(diffMaxLinesPerFile) || diffMaxLinesPerFile < 0) {
    throw new TypeError('compliance-check: diffMaxLinesPerFile 必须是非负整数(0 表示不限制)')
  }
  return {
    watchTools: new Set(watchTools),
    skipRe: skipPaths.map((re) => re instanceof RegExp ? re : new RegExp(re)),
    providerName,
    promptTemplate: typeof cfg.promptTemplate === 'string' ? cfg.promptTemplate : undefined,
    diffMaxChars,
    diffMaxLinesPerFile,
  }
}

/** 拆分文本为行:统一换行符;空文本为 0 行;结尾换行不产生多余空行。 */
function splitLines(text) {
  let t = String(text)
  if (t.length === 0) return []
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (t.endsWith('\n')) t = t.slice(0, -1)
  return t.split('\n')
}

/** 在 edits 末尾追加 a→b 的 LCS 编辑序列,稳定可回放。 */
function pushLcsEdits(edits, a, b) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const rev = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rev.push({ t: '=', l: a[i - 1] })
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      rev.push({ t: '-', l: a[i - 1] })
      i--
    } else {
      rev.push({ t: '+', l: b[j - 1] })
      j--
    }
  }
  while (i > 0) { rev.push({ t: '-', l: a[i - 1] }); i-- }
  while (j > 0) { rev.push({ t: '+', l: b[j - 1] }); j-- }
  for (let k = rev.length - 1; k >= 0; k--) edits.push(rev[k])
}

/** 计算 before→after 的整行编辑序列。 */
function computeLineEdits(before, after) {
  const a = splitLines(before)
  const b = splitLines(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const edits = []
  for (let i = 0; i < pre; i++) edits.push({ t: '=', l: a[i] })
  const midA = a.slice(pre, a.length - suf)
  const midB = b.slice(pre, b.length - suf)
  if (midA.length * midB.length > LCS_LIMIT) {
    // 超大中间段降级:整体视为替换
    for (const l of midA) edits.push({ t: '-', l })
    for (const l of midB) edits.push({ t: '+', l })
  } else {
    pushLcsEdits(edits, midA, midB)
  }
  const startA = a.length - suf
  for (let i = 0; i < suf; i++) edits.push({ t: '=', l: a[startA + i] })
  return edits
}

/** 把编辑序列渲染为近似 unified diff 的多 hunk 文本;无差异返回空串。 */
function renderHunks(edits, context = DIFF_CONTEXT) {
  const blocks = []
  let cur = null
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].t !== '=') {
      if (cur === null) cur = { s: i, e: i }
      cur.e = i
    } else if (cur !== null && i - cur.e > 2 * context) {
      blocks.push(cur)
      cur = null
    }
  }
  if (cur !== null) blocks.push(cur)
  if (blocks.length === 0) return ''
  const lines = []
  for (const blk of blocks) {
    const s = Math.max(0, blk.s - context)
    const e = Math.min(edits.length - 1, blk.e + context)
    let oldStart = 1
    let newStart = 1
    for (let i = 0; i < s; i++) {
      if (edits[i].t !== '+') oldStart++
      if (edits[i].t !== '-') newStart++
    }
    let oldCount = 0
    let newCount = 0
    for (let i = s; i <= e; i++) {
      if (edits[i].t !== '+') oldCount++
      if (edits[i].t !== '-') newCount++
    }
    const oh = oldCount === 0 ? '0,0' : oldStart + ',' + oldCount
    const nh = newCount === 0 ? '0,0' : newStart + ',' + newCount
    lines.push('@@ -' + oh + ' +' + nh + ' @@')
    for (let i = s; i <= e; i++) {
      const ed = edits[i]
      lines.push((ed.t === '=' ? ' ' : ed.t) + ed.l)
    }
  }
  return lines.join('\n')
}

/**
 * 渲染单个文件的 diff 文本;before 为 null 视为本轮新建。
 * maxLinesPerFile > 0 时,超出部分截断并附说明。
 */
function renderFileDiff(path, before, after, maxLinesPerFile) {
  const edits = computeLineEdits(before ?? '', after ?? '')
  const body = renderHunks(edits)
  if (body.length === 0) return '### ' + path + '\n(无文本差异)'
  let text = '### ' + path + '\n' + body
  if (maxLinesPerFile > 0) {
    const total = body.split('\n').length + 1
    if (total > maxLinesPerFile) {
      const keep = body.split('\n').slice(0, maxLinesPerFile - 1).join('\n')
      text = '### ' + path + '\n' + keep + '\n…(diff 共 ' + total + ' 行,已按 diffMaxLinesPerFile=' + maxLinesPerFile + ' 截断,可 read 该文件查看全貌)'
    }
  }
  return text
}

/**
 * 渲染本轮全部被改文件的 diff(files: Map<path, {before, after}>)。
 * maxChars > 0 时,总长超出则截断并附说明。
 */
/**
 * 按字符预算截断文本,避免按 UTF-16 码元直切切断代理对(emoji 等)。
 * 返回的文本长度可能略小于 maxChars(最多少 1 个码元)。
 */
function safeSlice(text, maxChars) {
  if (text.length <= maxChars) return text
  let cut = text.slice(0, maxChars)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}

/**
 * 渲染本轮全部被改文件的 diff(files: Map<path, {before, after}>)。
 * maxChars > 0 时,总长超出则截断(不切断代理对)并附说明。
 */
function renderDiff(files, maxChars, maxLinesPerFile) {
  const parts = []
  for (const [path, rec] of files) {
    parts.push(renderFileDiff(path, rec.before, rec.after, maxLinesPerFile))
  }
  let text = parts.join('\n\n')
  if (maxChars > 0 && text.length > maxChars) {
    const total = text.length
    text = safeSlice(text, maxChars) + '\n…(diff 已按 diffMaxChars=' + maxChars + ' 截断,原总长 ' + total + ' 字符,可 read 相关文件查看全貌)'
  }
  return text
}

/** 从会话事件流取最近一条真实用户消息文本(跳过插件注入)。 */
function lastUserMessageText(agent, maxChars) {
  const events = agent.session?.events
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const data = event.data
    if (data?.source?.kind !== 'user') continue
    const text = (data.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text.length === 0) continue
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…(已截断)' : text
  }
  return undefined
}

/** 构造检查子智能体的 prompt(files: Map<path, {before, after}>,before 为 null 表示本轮新建)。 */
function buildPrompt(agent, files, resolved) {
  const requirement = lastUserMessageText(agent, REQUIREMENT_MAX_CHARS)
  const fileList = [...files.keys()].map((f) => '- ' + f).join('\n')
  const diff = renderDiff(files, resolved.diffMaxChars, resolved.diffMaxLinesPerFile)
  const base = [
    '对本轮修改进行检查,输出分级报告。',
    '',
    '## 本轮用户输入',
    requirement ?? '(无法从会话中提取到用户需求文本,请仅基于修改内容评估)',
    '',
    '## 本轮修改的文件',
    fileList,
    '',
    '## 本轮改动 diff',
    '以下为各文件本轮改动前后的文本差异(行级,基于写工具的前后内容;新建文件无旧内容做整文件新增展示):',
    '',
    diff,
    '',
    '## 检查项',
    '- 需求完成度:需求是否完成?实现是否偏离需求?',
    '- 实现质量如何?(实现是否清晰、健壮、可维护,命名与结构是否符合项目惯例?)',
    '- 是否引入新问题或回归?',
    '- 注释、文档、AGENTS.md 等描述性内容是否与实际行为同步?(若存在)',
    '- 测试与回归是否对齐(若存在测试)?',
    '',
    '## 要求',
    '- 只读检查:禁止修改任何文件、禁止执行任何写操作。',
    '- 若改动极少且不影响主要路径,可直接给出"无需修改"的结论。',
    '- 输出:按严重程度分级的问题列表(严重/警告/疑问),每项含位置、原因、改进建议;最后给出总体结论。',
  ]
  if (resolved.promptTemplate) {
    return resolved.promptTemplate
      .replaceAll('{{requirement}}', requirement ?? '(无)')
      .replaceAll('{{files}}', fileList)
      .replaceAll('{{diff}}', diff)
  }
  return base.join('\n')
}

/** 继承主 agent 的 provider/model 路由,让检查子智能体与主会话同模型。 */
function inheritAgentOptions(agent) {
  const options = agent.options
  if (options == null) return undefined
  const result = {}
  if (typeof options.provider === 'string' && options.provider.length > 0) result.provider = options.provider
  if (typeof options.model === 'string' && options.model.length > 0) result.model = options.model
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 阻塞派发需求合规检查子智能体。
 * @param checkExempt 豁免集(子智能体自身),防嵌套检查
 * @returns 注入给主会话的文本(报告或失败说明);任何异常都在内部消化。
 */
async function runCheck(ctx, agent, files, turnSignal, resolved, checkExempt) {
  // cordis 服务需显式获取(ctx.get),直接属性访问会抛 "without inject"
  const subagents = ctx.get('subagents')
  if (subagents == null) return '[需求合规检查] 未执行:subagent 服务不可用,请自行自查。'
  let providerName = resolved.providerName
  if (subagents.getProvider(providerName) === undefined) {
    const names = subagents.list()
    if (names.length === 0) return '[需求合规检查] 未执行:无可用 subagent provider,请自行自查。'
    providerName = names[0]
  }
  const prompt = buildPrompt(agent, files, resolved)
  // 无超时:仅用户取消信号传播给子智能体(检查耗时不受限;子智能体挂死时由用户取消兜底)
  let run
  try {
    run = await subagents.start(providerName, {
      label: 'compliance-check',
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      signal: turnSignal,
      agentOptions: inheritAgentOptions(agent),
    })
  } catch (error) {
    return '[需求合规检查] 子智能体启动失败:' + String(error?.message ?? error) + ',请自行自查。'
  }
  // 子智能体已发布:豁免它自身,防止嵌套检查
  if (run.localAgent !== undefined) checkExempt.add(run.localAgent)
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      return '[需求合规检查] 子智能体未正常完成(stopReason: ' + result.stopReason + '),请自行自查。'
    }
    const output = result.output ?? []
    const text = output
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    return text.length > 0
      ? text
      : '[需求合规检查] 子智能体未输出报告内容,请自行自查。'
  } catch (error) {
    return '[需求合规检查] 子智能体执行失败:' + String(error?.message ?? error) + ',请自行自查。'
  } finally {
    try { run.dispose() } catch { /* 幂等清理,失败忽略 */ }
  }
}

/** 组装注入主会话的检查结果消息。 */
function resultMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'compliance-check', form: 'relay' },
  })
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  /** sessionId -> { files: Map<path, {before, after}>, checked: boolean } */
  const bySession = new Map()
  /** 检查子智能体本身(其 turn 结束不触发嵌套检查) */
  const checkExempt = new WeakSet()
  /** 嵌套工具调用记录冒泡:parent token -> {path, before, after}[] */
  const executionTouches = new Map()

  // 会话销毁时清理状态,避免 Map 累积(payload 为 { agent })
  ctx.on('agent/disposed', (payload) => {
    bySession.delete(payload.agent?.session?.id)
    executionTouches.clear()
  })

  // ── 1. 收集修改文件及 before/after(≈ Trae PostToolUse) ──────────────
  ctx.on('tools/result', (exec, result) => {
    try {
      if (result.isError || exec.agent === undefined || exec.signal?.aborted) return
      // 本执行自身的写记录:write/edit 成功时 canonical value 含 before/after
      let own
      if (resolved.watchTools.has(exec.name)) {
        const p = exec.arguments?.file_path
        if (typeof p === 'string' && p.trim().length > 0) {
          const v = result.value
          let before
          let after
          if (v != null && typeof v === 'object') {
            // write 新建时 before 为 null;取不到文本时按无内容处理
            before = typeof v.before === 'string' ? v.before : null
            after = typeof v.after === 'string' ? v.after : undefined
          }
          own = { path: p.trim(), before, after }
        }
      }
      // 嵌套调用(如 run_code 内的 edit/write):整条记录冒泡到顶层执行
      if (exec.parent !== undefined) {
        if (own !== undefined) {
          const existing = executionTouches.get(exec.parent)
          if (existing === undefined) executionTouches.set(exec.parent, [own])
          else existing.push(own)
        }
        return
      }
      // 顶层执行:合并自身记录与冒泡来的嵌套记录
      const records = own !== undefined ? [own] : []
      const bubbled = executionTouches.get(exec.token)
      if (bubbled !== undefined) {
        executionTouches.delete(exec.token)
        for (const r of bubbled) records.push(r)
      }
      if (records.length === 0) return
      const sessionId = exec.agent.session?.id
      if (sessionId === undefined) return
      let state = bySession.get(sessionId)
      if (state === undefined) {
        state = { files: new Map(), checked: false }
        bySession.set(sessionId, state)
      }
      for (const r of records) {
        if (resolved.skipRe.some((re) => re.test(r.path))) continue
        const rec = state.files.get(r.path)
        if (rec === undefined) {
          // 本轮首次写入:before 即本轮起点(新建为 null),after 取当前内容
          state.files.set(r.path, { before: r.before, after: r.after })
        } else {
          // 同一文件多次编辑:before 保持本轮首次记录(净 diff 起点),after 刷新为最终
          rec.after = r.after
        }
      }
    } catch { /* 观察器异常静默,不影响工具结果 */ }
  })

  // ── 2. 用户新输入:重置检查状态(每个用户输入最多检查一次) ──────────
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    try {
      if (messages.some((m) => m?.source?.kind === 'user')) {
        bySession.set(agent.session?.id, { files: new Map(), checked: false })
      }
    } catch { /* 静默 */ }
    return next()
  })

  // ── 3. 轮次结束前:触发检查(≈ Trae Stop) ──────────────────────────
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (checkExempt.has(agent)) return
    const sessionId = agent.session?.id
    if (sessionId === undefined) return
    const state = bySession.get(sessionId)
    if (state === undefined || state.files.size === 0 || state.checked) return
    state.checked = true // 先置位,防重入
    try {
      const text = await runCheck(ctx, agent, state.files, signal, resolved, checkExempt)
      if (signal.aborted) return // 轮次已被取消,不再注入
      agent.inject(resultMessage(text))
    } catch (error) {
      // 兜底:任何异常都不阻塞 turn 关闭
      try {
        if (!signal.aborted) agent.inject(resultMessage('[需求合规检查] 执行异常:' + String(error?.message ?? error) + ',请自行自查。'))
      } catch { /* 注入失败则静默 */ }
    }
  })
}