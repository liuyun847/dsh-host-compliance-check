/**
 * dsh-host-compliance-check 回归测试(只读,不改动插件本身)。
 *
 * 运行方式(工作目录不限):
 *   node tests/diff.test.mjs
 *
 * 原理:读取 ../lib/index.js 源码,剥离 import 与 export 关键字(当前仅单行 import),
 * 再以 new Function 装载进本进程执行断言。
 * 若 lib/index.js 的 import/export 结构变化导致装载失效,测试会直接报语法错误,请同步更新本文件头部的剥离逻辑。
 *
 * 覆盖范围:
 *  - 行级 diff 渲染:新建/中段替换/整删/空内容/CRLF/多 hunk/超大中间段降级/尾部追加/行尾换行
 *  - 截断:单文件行数上限、总字符上限、代理对(emoji)不切断
 *  - buildPrompt:文件列表、diff 区块、{{requirement}}/{{files}}/{{diff}} 模板、多次编辑合并语义
 *  - resolveConfig:默认值(0 不限制)与非法配置抛错
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  .replace(/^\s*import\s+.*$/gm, '')
  .replace(/^\s*export\s+/gm, '')

// 装载插件源码(其导出在当前上下文不可见,故剥离 import 后拼接测试尾)
const runner = new Function(pluginSrc + '\n;return { resolveConfig, buildPrompt, renderFileDiff, renderDiff, safeSlice, computeLineEdits };')
const { resolveConfig, buildPrompt, renderFileDiff, renderDiff, safeSlice, computeLineEdits } = runner()

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (detail ? '\n' + detail : '')) }
}
const hasCR = (s) => s.split('').some((ch) => ch.charCodeAt(0) === 13)
const isLoneSurrogateTail = (s) => {
  const c = s.charCodeAt(s.length - 1)
  return c >= 0xd800 && c <= 0xdbff
}

// ── 一、行级 diff 渲染 ─────────────────────────────
const r1 = renderFileDiff('a/new.txt', null, 'line1\nline2\nline3')
check('diff.create-file', r1.includes('@@ -0,0 +1,3 @@') && r1.includes('+line1') && r1.includes('+line3'), r1)

const before2 = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg'].join('\n')
const after2 = ['aaa', 'bbb', 'CCC!!', 'DDD!!', 'eee', 'fff', 'ggg'].join('\n')
const r2 = renderFileDiff('b/edit.txt', before2, after2)
check('diff.mid-edit', r2.includes('@@ -1,7 +1,7 @@') && r2.includes('-ccc') && r2.includes('+CCC!!') && r2.includes('-ddd') && r2.includes('+DDD!!') && r2.includes(' aaa') && r2.includes(' ggg'), r2)

const r3 = renderFileDiff('c/del.txt', 'x\ny\nz', '')
check('diff.delete-all', r3.includes('@@ -1,3 +0,0 @@') && r3.includes('-x') && r3.includes('-z'), r3)

const r4 = renderFileDiff('d/empty.txt', '', '')
check('diff.no-diff', r4.includes('(无文本差异)'), r4)

const r5 = renderFileDiff('e/crlf.txt', 'a\r\nb\r\n', 'a\r\nb\r\nc')
check('diff.crlf', r5.includes('+c') && !hasCR(r5), r5)

const bigBefore = Array.from({ length: 20 }, (_, i) => 'old' + i).join('\n')
const bigAfter = Array.from({ length: 20 }, (_, i) => 'new' + i).join('\n')
const r6 = renderFileDiff('f/big.txt', bigBefore, bigAfter, 6)
check('diff.trunc-lines', r6.split('\n').length <= 8 && r6.includes('已按 diffMaxLinesPerFile=6 截断'), r6)

const before7 = Array.from({ length: 30 }, (_, i) => 'l' + i).join('\n')
const after7 = before7.replace('l2', 'L2!').replace('l25', 'L25!')
const r7 = renderFileDiff('g/multi.txt', before7, after7)
check('diff.multi-hunk', ((r7.match(/@@/g) || []).length / 2) === 2, r7)

const hugeA = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n')
const hugeB = Array.from({ length: 3000 }, (_, i) => 'B' + i).join('\n')
const r8 = renderFileDiff('h/huge.txt', hugeA, hugeB)
check('diff.huge-fallback', r8.split('\n').length > 5000, String(r8.split('\n').length))

const r9 = renderFileDiff('i/append.txt', 'x\ny', 'x\ny\nz')
check('diff.append', r9.includes('@@ -1,2 +1,3 @@') && r9.includes('+z'), r9)

const r10 = renderFileDiff('j/trail.txt', 'x\n\n', 'x\n\ny')
check('diff.trailing-newline', r10.includes('+y') && !r10.includes('-\n'), JSON.stringify(r10))

// ── 二、截断与代理对 ───────────────────────────────
const emoji = 'A'.repeat(100) + '🎉'.repeat(50)
const e1 = safeSlice(emoji, 120)
check('slice.no-lone-surrogate', !isLoneSurrogateTail(e1) && e1.length <= 120, e1 + ' len=' + e1.length)

const bigMap = new Map([['big.txt', {
  before: Array.from({ length: 30 }, (_, i) => 'o' + i).join('\n'),
  after: Array.from({ length: 30 }, (_, i) => 'n' + i).join('\n'),
}]])
const r11 = renderDiff(bigMap, 60, 0)
check('diff.trunc-chars', r11.includes('已按 diffMaxChars=60 截断') && !isLoneSurrogateTail(r11), r11)

// ── 三、buildPrompt 集成 ───────────────────────────
const files = new Map([
  ['a/new.txt', { before: null, after: 'A\nB' }],
  ['b/edit.txt', { before: 'x\ny\nz', after: 'x\nY2\nz' }],
])
const agent = { session: { events: [
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '重构 b 并新增 a' }] } },
] } }
const resolved0 = { diffMaxChars: 0, diffMaxLinesPerFile: 0 }
const prompt = buildPrompt(agent, files, resolved0)
check('prompt.has-files', prompt.includes('## 本轮修改的文件') && prompt.includes('- a/new.txt') && prompt.includes('- b/edit.txt'))
check('prompt.has-diff', prompt.includes('## 本轮改动 diff') && prompt.includes('@@ -0,0 +1,2 @@') && prompt.includes('-y') && prompt.includes('+Y2'))
check('prompt.has-requirement', prompt.includes('重构 b 并新增 a'))
check('prompt.quality-item', prompt.includes('实现质量如何'))

const prompt2 = buildPrompt({ session: { events: [] } }, files, resolved0)
check('prompt.no-requirement', prompt2.includes('无法从会话中提取'))

const prompt3 = buildPrompt(agent, files, { ...resolved0, promptTemplate: '需求:{{requirement}}\n文件:\n{{files}}\n差异:\n{{diff}}' })
check('prompt.template-diff', prompt3.startsWith('需求:') && prompt3.includes('差异:\n### a/new.txt') && prompt3.includes('@@ -0,0 +1,2 @@'))

const prompt4 = buildPrompt(agent, bigMap, { diffMaxChars: 0, diffMaxLinesPerFile: 4 })
check('prompt.trunc-lines', prompt4.includes('已按 diffMaxLinesPerFile=4 截断') && prompt4.includes('可 read 该文件查看全貌'))

const prompt5 = buildPrompt(agent, bigMap, { diffMaxChars: 60, diffMaxLinesPerFile: 0 })
const diffPart = (prompt5.split('## 本轮改动 diff')[1] ?? '').split('## 检查项')[0] ?? ''
check('prompt.trunc-chars', prompt5.includes('已按 diffMaxChars=60 截断') && diffPart.length < 200 && diffPart.length > 50, diffPart)

const prompt6 = buildPrompt(agent, new Map([['f.txt', { before: null, after: 'v2' }]]), resolved0)
check('prompt.merge-after', prompt6.includes('+v2') && !prompt6.includes('+v1'))

const prompt7 = buildPrompt(agent, new Map([['e.txt', { before: '', after: '' }]]), resolved0)
check('prompt.empty-content', prompt7.includes('(无文本差异)'))

// ── 四、resolveConfig ──────────────────────────────
const rc = resolveConfig({})
check('config.defaults', rc.diffMaxChars === 0 && rc.diffMaxLinesPerFile === 0 && rc.promptTemplate === undefined)
let threw = false
try { resolveConfig({ diffMaxChars: -1 }) } catch (e) { threw = e instanceof TypeError }
check('config.reject-negative', threw)
threw = false
try { resolveConfig({ diffMaxLinesPerFile: 1.5 }) } catch (e) { threw = e instanceof TypeError }
check('config.reject-fraction', threw)
threw = false
try { resolveConfig({ watchTools: [] }) } catch (e) { threw = e instanceof TypeError }
check('config.reject-empty-watch', threw)
const rc2 = resolveConfig({ diffMaxChars: 8000, diffMaxLinesPerFile: 200 })
check('config.custom-values', rc2.diffMaxChars === 8000 && rc2.diffMaxLinesPerFile === 200)

console.log('----')
console.log('pass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)