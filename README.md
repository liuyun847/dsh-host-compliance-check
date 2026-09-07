# dsh-host-compliance-check

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.0-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)

DSH(DeepSeek Harness)宿主插件:模仿 Trae 的 stop-hook 配置(hooks.json 的
PostToolUse + Stop → decision 移交),**不自动派发检查子智能体**;在主会话
轮次正常结束时,若本轮修改过文件,向主会话注入一段 **notice 形态的合规提醒
提示词**(source.form='notice' + 一句话 summary,正文带文件清单),由主模型
当场自行判断:直接收尾 / 简要自查 / 阻塞调用 subagent 深入检查。

> (v0.4.0 变更) 与 0.3.x 的差异:
> - **收集信源从"会话事件日志 + run_code 源码启发式解析"改为 `tools/result`
>   实时精确记录** —— 顶层 write/edit 与 run_code 内 `tools.write/edit`
>   子派发都经工具管道 emit `tools/result`(`exec.name`/`exec.arguments` 为真实
>   调用,`exec.agent` 携带会话),`file_path` 精确,删除正则猜源码的脆弱逻辑;
> - 注入消息由裸 plugin 文本改为 **notice 形态**(`form:'notice'` + `summary`
>   ≤120,`boundContextSummary` 语义),不再以 `[AUTO]` 文本冒充用户输入;
> - diag 日志路径改为基于 `DSH_HOME`/用户主目录推导,不再硬编码。

## 特性

- 轮末提醒:主会话轮次正常结束时,若本轮修改过文件且本用户输入尚未提醒过,
  注入 notice 提醒(进 next-step 队列 → 本 turn 继续,主模型当场看到并响应,
  响应完 turn 才真正结束 —— 等价 Trae 的 block)
- **精确收集 = `tools/result` 实时记录**(对顶层 write/edit 与 run_code 内子派发
  均触发;scope-filtered 按 agent 分发):
  - `exec.name` ∈ {write, edit} 且成功 → 提取真实 `file_path`;
  - 事件日志仅作兜底(顶层 `tool/call` 的 write/edit),不再解析 run_code 源码
- **只支持标准模式写入**;PTC 裸写(`await import('node:fs')` + 直接文件 API,
  绕过 `tools` 绑定)不经过工具管道、不产生 `tools/result`,本插件检测不到
  (已知限制;合规做法是程序内用 `tools.write/edit`)
- 每用户输入最多提醒一次(新用户消息经 `agent/pre-step` 复位记录与标记)
- 只对主会话触发:**GUI 恢复/续写历史会话创建的 fork 会话(带 parentSession、无 origin)视为主会话**,照常提醒;仅排除子代理会话(header `origin: 'subagent'`),避免嵌套提醒
- 提示词携带**全部用户输入历史**(按时间顺序拼接、跳过插件注入,超长截断保留最新)供对照,
  不只取最近一条;内置自查清单与处理方式引导(可直接结束 / 阻塞调 subagent 深查)
- 提醒以 **notice** 消息呈现(`source.form='notice'`,summary 一句话 ≤120),UI 折叠展示、不冒充用户输入

## 配置(cordis.patch.yml 的 entry config)

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `skipPaths` | `[]` | 跳过匹配的路径(RegExp/字符串数组),命中则不记录 |
| `diag` | `false` | 写诊断日志到 `~/.dsh/compliance-diag.log`(DSH_HOME 优先;排查用) |

(0.2.x 的 `providerName`/`promptTemplate`/`diffMaxChars`/`diffMaxLinesPerFile`/`watchTools`
与 0.3.x 的源码解析逻辑均已移除。)

## 安装

在 DSH profile 目录(例如 `~/.dsh/profiles/web/`)下:

1. 添加依赖:

   ```jsonc
   // package.json
   {
     "dependencies": {
       "dsh-host-compliance-check": "file:./plugins/dsh-host-compliance-check"
     }
   }
   ```

   然后 `pnpm install`(或 `npm install`)。

2. 在 `cordis.patch.yml` 中注册插件行:

   ```yaml
   - insert:
       - id: compliance-check
         name: 'dsh-host-compliance-check'
   ```

3. 重启 `dsh web` 生效。

> 注意:本仓库以 `plugins/dsh-host-compliance-check/` 为**活源**,运行时加载
> `node_modules/` 下的 **file: 拷贝**(二者独立)。改动活源后需把
> `lib/index.js`、`package.json`、`tests/` 同步复制到
> `node_modules/dsh-host-compliance-check/`,再重启 dsh 才生效。

## 工作原理

- 监听 `agent/pre-step`:检测到用户新消息(`source.kind === 'user'`)时复位
  该会话的"已提醒"标记与本轮写入记录;
- 监听 `tools/result`:每次工具成功结束(顶层或 run_code 子派发),若是
  write/edit 则把精确 `file_path` 记入该会话本轮表(应用 skipPaths 过滤);
- 监听 `agent/turn-stopping`(≈ Trae Stop):仅主会话且未提醒过、本轮表非空时,
  `agent.inject` 注入 notice 提醒 —— 注入 next-step 使本 turn 继续,主模型当场响应;
- 事件日志兜底:仅当实时记录缺失时,从会话事件取顶层 `tool/call` 的 write/edit;
- 提示词正文带文件清单、本轮用户输入摘录、自查清单与处理方式引导(可直接结束或
  阻塞调 subagent/subagent_fork 深查);
- **已知边界**:run_code 程序内 PTC 裸写(`await import('node:fs')` 等直接文件
  API,绕过 `tools` 绑定)不产生 `tools/result`,本插件不检测;如需要覆盖请改用
  `tools.write/edit`;
- 无子代理派发、无 `ctx.get('subagents')` 依赖。

## 开发

```bash
pnpm install
# 修改活源 plugins/dsh-host-compliance-check/ 后,同步 lib/ 与 package.json 到
# node_modules/dsh-host-compliance-check/(file: 拷贝,不自动同步),再重启 dsh
# 纯函数单测(提取/记录/收集/提示词组装):
node plugins/dsh-host-compliance-check/tests/diff.test.mjs
```

## License

MIT
