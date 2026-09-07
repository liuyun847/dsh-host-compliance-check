/**
 * dsh-host-compliance-check v0.4.0 回归测试(只读,不改动插件本身)。
 *
 * 运行方式(工作目录不限):
 *   node tests/diff.test.mjs
 *
 * 原理:读取 ../lib/index.js 源码,剥离 import 与 export 关键字(当前仅单行 import),
 * 再以 new Function 装载进本进程执行断言。由于模块顶层有 import { createUserMessage }
 * 等 ESM 依赖,剥离后仅测试不触碰这些依赖的纯函数(collectTurnWritesFromEvents、
 * lastUserMessageText 等不调用外部依赖;buildNoticeMessage 依赖 createUserMessage,
 * 仅在存在该绑定时测;否则跳过)。
 *
 * 覆盖范围(0.4.0):
 *  - extractFilePath:字符串/对象/非法 JSON/无 file_path 的提取
 *  - noteTurnWrite/sessionTurnWrites/clearSessionTurnWrites:精确优先、去重、复位
 *  - collectTurnWritesFromEvents:只取顶层 tool/call 的 write/edit(带 turn),run_code 不解析源码
 *  - isRootSession:主会话判定(origin!=='subagent')
 *  - lastUserMessageText:跳过插件注入与 goal、按序拼接、截断保最新、不切代理对
 *  - buildPromptBody:文件清单/自查清单/处理引导/用户历史
 *  - buildNoticeMessage(若 createUserMessage 可剥离注入):source.form='notice' + summary≤120
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  .replace(/^\s*import\s+.*$/gm, '')
  .replace(/^\s*export\s+/gm, '')

// 装载插件源码。buildNoticeMessage 用到 createUserMessage,剥离 import 后不可见,
// 故在剥离后的源码末尾追加一个占位 createUserMessage(只返回结构化消息,不依赖
// 真实 dsh-llm),仅验证 source 形态与 summary 截断。
const injected = '\nfunction createUserMessage(input) { return { id: "msg-" + Math.random(), role: "user", ...input } }\n'
const runner = new Function(pluginSrc + injected + '\n;return { safeSlice, extractFilePath, noteTurnWrite, sessionTurnWrites, clearSessionTurnWrites, collectTurnWritesFromEvents, lastUserMessageText, isRootSession, buildPromptBody, buildNoticeMessage };')
const {
  safeSlice, extractFilePath, noteTurnWrite, sessionTurnWrites, clearSessionTurnWrites,
  collectTurnWritesFromEvents, lastUserMessageText, isRootSession, buildPromptBody, buildNoticeMessage,
} = runner()

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (detail ? '\n' + detail : '')) }
}
const isLoneSurrogateTail = (s) => {
  const c = s.charCodeAt(s.length - 1)
  return c >= 0xd800 && c <= 0xdbff
}

// ── 一、extractFilePath ─────────────────────────────
check('extract.obj', extractFilePath({ file_path: 'C:/a/b.txt' }) === 'C:/a/b.txt')
check('extract.jsonstr', extractFilePath('{"file_path":"C:/a/b.txt"}') === 'C:/a/b.txt')
check('extract.badjson', extractFilePath('{oops') === null)
check('extract.no-field', extractFilePath({ path: 'x' }) === null)
check('extract.empty', extractFilePath({ file_path: '' }) === null)
check('extract.null', extractFilePath(null) === null && extractFilePath(undefined) === null)
check('extract.backslash', extractFilePath({ file_path: 'C:\\a\\b.txt' }) === 'C:\\a\\b.txt')

// ── 二、noteTurnWrite / sessionTurnWrites / clear ──
noteTurnWrite('s1', 'C:/x/a.md', false)
noteTurnWrite('s1', 'C:/x/b.md', true)
noteTurnWrite('s1', 'C:/x/a.md', true) // 已精确,推断不降级
noteTurnWrite('s1', 'C:\\x\\c.md', false) // 反斜杠规整
noteTurnWrite('s1', '', false) // 空忽略
const w1 = sessionTurnWrites('s1')
check('note.collects', w1?.size === 3, w1 ? String(w1.size) : 'none')
check('note.exact-wins', w1?.get('C:/x/a.md')?.inferred === false)
check('note.inferred-marked', w1?.get('C:/x/b.md')?.inferred === true)
check('note.normalize-backslash', w1?.has('C:/x/c.md'))
check('note.session-isolated', sessionTurnWrites('s2') === undefined)
clearSessionTurnWrites('s1')
check('note.clear', sessionTurnWrites('s1') === undefined)

// ── 三、collectTurnWritesFromEvents(事件兜底,只收顶层 write/edit) ──
const agentEv = {
  session: {
    ownEvents: () => [
      { type: 'tool/call', data: { turn: 5, name: 'write', arguments: '{"file_path":"C:/t/w.txt"}' } },
      { type: 'tool/call', data: { turn: 5, name: 'edit', arguments: { file_path: 'C:/t/e.txt' } } },
      { type: 'tool/call', data: { turn: 5, name: 'run_code', arguments: '{"code":"fs.writeFileSync(\'C:/t/fromcode.txt\', \'x\')"}' } },
      { type: 'tool/call', data: { turn: 6, name: 'write', arguments: '{"file_path":"C:/t/other-turn.txt"}' } },
      { type: 'tool/call', data: { turn: 5, name: 'read', arguments: '{"file_path":"C:/t/read.txt"}' } },
    ],
  },
  phase: { turn: 5 },
}
const evFiles = collectTurnWritesFromEvents(agentEv, 5)
check('events.precise-write', evFiles.has('C:/t/w.txt'))
check('events.precise-edit', evFiles.has('C:/t/e.txt'))
check('events.no-runcode-source-parse', !evFiles.has('C:/t/fromcode.txt'), JSON.stringify([...evFiles.keys()]))
check('events.turn-filtered', !evFiles.has('C:/t/other-turn.txt'))
check('events.no-read', !evFiles.has('C:/t/read.txt'))
check('events.size', evFiles.size === 2, String(evFiles.size))

// 无 ownEvents 时回退 snapshotEvents
const agentSnap = { session: { snapshotEvents: () => [{ type: 'tool/call', data: { turn: 2, name: 'write', arguments: { file_path: 'C:/s/x.txt' } } }] } }
check('events.snapshot-fallback', collectTurnWritesFromEvents(agentSnap, 2).has('C:/s/x.txt'))
check('events.no-events', collectTurnWritesFromEvents({ session: {} }, 1).size === 0)
check('events.null-agent', collectTurnWritesFromEvents(null, 1).size === 0)

// ── 四、isRootSession ───────────────────────────────
check('scope.origin-subagent-false', !isRootSession({ header: { origin: 'subagent' } }))
check('scope.origin-undefined-true', isRootSession({ header: {} }))
check('scope.origin-other-true', isRootSession({ header: { origin: 'something' } }))
check('scope.null-false', !isRootSession(null) && !isRootSession(undefined))

// ── 五、lastUserMessageText(跳插件注入/goal、拼接、截断) ──
const agentMsgs = {
  session: {
    snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一句' }] } },
      { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '注入跳过' }] } },
      { type: 'user/message', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: 'goal 跳过' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二句' }] } },
    ],
  },
}
const all = lastUserMessageText(agentMsgs, 4000)
check('user.all', all.includes('第一句') && all.includes('第二句'))
check('user.plugin-skipped', !all.includes('注入跳过') && !all.includes('goal 跳过'))
check('user.order', all.indexOf('第一句') < all.indexOf('第二句'))
check('user.undefined-none', lastUserMessageText({ session: { snapshotEvents: () => [] } }, 10) === undefined)

const longAgent = { session: { snapshotEvents: () => [
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '旧' + 'x'.repeat(5000) }] } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '新需求' }] } },
] } }
const trunc = lastUserMessageText(longAgent, 50)
check('user.trunc-keeps-new', trunc.includes('新需求') && !trunc.includes('旧'))
check('user.trunc-marker', trunc.startsWith('…(已截断)'))
check('user.trunc-length', trunc.length <= 50 + '…(已截断)'.length + 1, String(trunc.length))
check('user.trunc-no-lone-surrogate', !isLoneSurrogateTail(trunc))

// ── 六、buildPromptBody ─────────────────────────────
const pfiles = new Map([
  ['C:/a/new.md', { inferred: false }],
  ['C:/b/edit.md', { inferred: true }],
])
const body = buildPromptBody(pfiles, '改 a 和 b')
check('prompt.files', body.includes('本轮修改了文件:') && body.includes('- C:/a/new.md') && body.includes('- C:/b/edit.md'))
check('prompt.quality', body.includes('需求是否完成') && body.includes('是否引入新问题'))
check('prompt.guidance', body.includes('subagent') && body.includes('排除误报') && body.includes('做适当改进'))
check('prompt.history', body.includes('## 用户输入历史') && body.includes('改 a 和 b'))
check('prompt.no-requirement', !buildPromptBody(pfiles, undefined).includes('## 用户输入历史'))

// ── 七、buildNoticeMessage(source notice 形态) ──
const notice = buildNoticeMessage({ content: '正文', summary: 's'.repeat(200) })
check('notice.role-user', notice.role === 'user')
check('notice.source-plugin', notice.source?.kind === 'plugin' && notice.source?.plugin === 'compliance-check')
check('notice.source-form', notice.source?.form === 'notice')
check('notice.summary-bounded', notice.source?.summary?.length <= 120, String(notice.source?.summary?.length))
check('notice.content', notice.content?.[0]?.text === '正文')

// safeSlice(代理对不切断)
const emoji = 'A'.repeat(100) + '🎉'.repeat(50)
check('slice.no-lone-surrogate', !isLoneSurrogateTail(safeSlice(emoji, 120)) && safeSlice(emoji, 120).length <= 120)
check('slice.identity', safeSlice('abc', 10) === 'abc')

console.log('----')
console.log('pass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)
