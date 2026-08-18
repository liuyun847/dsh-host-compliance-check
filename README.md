# dsh-host-compliance-check

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)

DSH(DeepSeek Harness)宿主插件:每个用户输入轮次结束时,若本轮修改过文件,自动派发一个**需求合规检查子智能体**(阻塞执行),把检查报告注入主会话,防止"改完就忘、需求没对齐就收尾"(迁移自 Trae 的 PostToolUse + Stop hook)。

## 特性

- 轮末自动检查:轮次正常结束时,若本轮改过文件且尚未检查,阻塞派发检查子智能体,报告注入主会话
- 每用户输入最多检查一次,避免重复
- 防递归:检查子智能体自身纳入豁免集
- 净 diff 注入:同一文件多次编辑合并为首版 before → 最终 after 的行级 diff(近似 unified diff 多 hunk)
- 内容截断保护:超大 diff 按字符/行数上限截断,并提示检查子智能体 read 原文件查看全貌

## 配置(cordis.patch.yml 的 entry config)

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `watchTools` | `['write', 'edit']` | 记录哪些写工具修改 |
| `skipPaths` | `[]` | 跳过匹配的路径(RegExp/字符串数组) |
| `providerName` | `'subagent-fork-in-process'` | 检查子智能体的 provider |
| `promptTemplate` | 内置模板 | 自定义模板,支持 `{{requirement}}` / `{{files}}` / `{{diff}}` |
| `diffMaxChars` | `0` | 注入 prompt 的 diff 总字符上限,0 = 不限制 |
| `diffMaxLinesPerFile` | `0` | 单文件 diff 行数上限,0 = 不限制 |

极端大 diff 场景(超大文件整段重写、多文件大改)可按需设置上限,例如 `diffMaxChars: 8000`、`diffMaxLinesPerFile: 200`。

## 安装

在 DSH profile 目录(例如 `~/.dsh/profiles/web/`)下:

1. 添加依赖:

   ```jsonc
   // package.json
   {
     "dependencies": {
       "dsh-host-compliance-check": "github:<你的用户名>/dsh-host-compliance-check"
     }
   }
   ```

   然后 `pnpm install`(或 `npm install`)。

2. 在 `cordis.patch.yml` 中注册插件行(可加 config 覆盖默认值):

   ```yaml
   - insert:
       - id: compliance-check
         name: 'dsh-host-compliance-check'
   ```

3. 重启 `dsh web` 生效。

## 工作原理

- 监听 `tools/result`(≈ PostToolUse):记录本轮修改过的文件及 before/after 内容,嵌套工具调用经 parent token 冒泡到顶层
- 监听 `agent/turn-stopping`(≈ Stop):轮次要正常结束时,若本轮改过文件且未检查,派发检查子智能体并 `await` 其完成,主会话挂起
- 检查子智能体返回报告即完成(无完成标记协议),每个用户输入最多触发一次

## 测试

纯逻辑回归测试(无 DSH 运行时):

```
node tests/diff.test.mjs
```

退出码 0 = 通过。

## License

MIT