# dsh-restart-guard · 重启守护

[![ci](https://github.com/FoolishWiser/dsh-restart-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/FoolishWiser/dsh-restart-guard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-restart-guard.svg)](https://www.npmjs.com/package/dsh-restart-guard)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)

[English](README.en.md) · **简体中文**

为 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 Web 服务加一个**能在宿主进程死掉后继续存活**的守护进程：发现重启没起来，按一组小规则判断原因，能修的自己修，修不了就把过程和结论发到你指定的渠道（IM、Webhook、命令或本地日志）。

它解决的问题很具体：容器/脚本里 `dsh web` 是后台启动、启动器随后 `exec` 成代理，**没有任何 supervisor 会在插件加载失败、patch 写坏、端口被占时把服务拉起来**。页面 502 到有人发现为止，中间没有任何信息。

```text
DSH 宿主 (dsh web)                     独立 watcher
┌───────────────────────┐   spawn    ┌──────────────────────────────┐
│ 插件：体检 / 路由 /   │ ─────────► │ 每 2s 探测 127.0.0.1:<port>/  │
│ 设置页                │            │ 字节偏移确认就绪 → 诊断 → 修复 │
│                       │ ◄───────── │        → 通知                 │
└───────────────────────┘  state.json└──────────────────────────────┘
        │ 崩溃 / 被杀                         │
        ▼                                     ▼
   端口消失  ─────────────────────────►  重启 / 回滚 patch / 停下并告警
```

## 能力

- **活得比宿主久**：watcher 由插件以 detached 方式拉起，和 DSH 没有父子关系；`kill -9` DSH 不会带走它。
- **知道什么叫“起来了”**：`401` 且正文是 DSH 的鉴权文案，或 `200` 且含 `__DSH_BOOT__` 才算 DSH；普通的 200 HTML 是陌生监听者，既不算健康，也绝不会被当成 DSH 杀掉。
- **只认新进程的新日志**：就绪判定读取本次 spawn **之后**追加的字节，必须出现带 token 的 `dsh web:` 访问行，再 settle 复验。整文件 grep 会命中旧行、拿到旧 token，这里刻意不做。
- **有边界的修复阶梯**：用抓到的 argv/env/cwd 重启；把 `cordis.patch.yml` 回滚到**能通过 `--dump-config` 的最新备份**；或者停下并把证据交给人。每个事件最多启动 2 次；10 分钟 3 次崩溃进入 30 分钟暂停，避免重启风暴。
- **升级/维护期免误判**：显式维护窗口、包树 inode/版本变化、`<pkgRoot>.prev-*` 等兄弟目录、包管理器进程、`$DSH_HOME/upgrade` 最新目录、慢启动六路信号任一命中即进入维护态：**不启动、不回滚、不杀进程**。
- **尊重主动停止**：宿主 `exit(0)` 被当作“操作者有意停的”，不拉起。
- **通知到你所在的地方**：本地日志恒开；Webhook（飞书、企业微信、钉钉、Slack、Telegram、Discord、ntfy、healthchecks、通用 JSON）；任意命令（argv 直传、消息走 stdin）；`dsh-im` 插件（宿主不在线时先落盘，回来后补发）。设置页点“扫描 dsh-im”可直接从已装插件里列出 bot 与 target，不用手抄 ID。
- **装完就告诉你环境缺什么**：设置页顶部有体检卡（启动日志、patch 备份、Webhook/IM、监督者、维护态），每个缺口都给出可操作提示；另有一键“模拟崩溃”演练。
- **可选 AI 辅助判定**：规则确实没有安全动作时才征询模型，模型只能选“重试 / 回滚 patch / 等待 / 人工”，不会执行任何命令（详见下文）。

## 安装

```bash
# 1. 本地目录或 npm 包
cd /path/to/dsh-restart-guard
pnpm install --ignore-scripts

# 2. 链接进 profile（会备份 package.json 并跑 pnpm install）
npx dsh-restart-guard install --profile web
#    或：dsh plugin --profile web add dsh-restart-guard
#    然后手动把 "dsh-restart-guard" 加进 profiles/web/package.json 的 dsh.profile.bundles

# 3. 重启 DSH，让插件加载（watcher 随宿主启动）
```

重启后打开 **设置 → 重启守护**：顶部体检报告会列出还缺什么（Webhook 地址、IM 的 `botId`/`targetId`、启动日志路径……），在页面里补完，点 **测试通知**。

命令行核对：

```bash
dsh-restart-guard status      # watcher / 阶段 / 最近健康状态
dsh-restart-guard doctor      # 与设置页同一套体检
dsh-restart-guard logs -f     # 跟随守护日志
```

### 环境要求

| 项 | 要求 |
| --- | --- |
| Node | ≥ 22 |
| DSH | ≥ 0.2.1（用到 host 插件 API 与 `webServer.tapIndex`） |
| 系统 | Linux 完整支持（依赖 `/proc`）；macOS 可用探测与监督逻辑，进程/端口映射回退到 `lsof` |
| 运行时依赖 | 无 |

### 升级 DSH 时

照常升级即可。升级脚本通常会杀掉旧进程、换树、再拉起；watcher 能从换树/兄弟目录/升级目录/包管理器进程/restarter 进程识别出“这是维护”，只观察、不抢端口、不中途回滚文件。维护窗口是**锚定**的：同一信号沿用原截止时间，不会因为进程还在而每 2 秒往后顺延；每个窗口只通知一次（信号变化才再发），显式窗口（`maintenance start --minutes N`）严格按 N 分钟结束、不额外加 `graceMs`。

## 修复判定

探测失败 → 宽限 → 诊断 → 计划：

| 诊断（先匹配者优先） | 日志示例 | 动作 |
| --- | --- | --- |
| `yaml-config` | `YAMLException`、`bad indentation` | 回滚到最新可用备份，再启动 |
| `patch-incompatible` | `cannot get property "webRuntime" without inject` | 首次回滚，之后仅重启 |
| `wildcard-host` | `host "0.0.0.0" is an unspecified (wildcard) address` | 停下，需改配置 |
| `port-in-use` | `EADDRINUSE` | 端口被占：停下（开启 `killStaleDshHolder` 时只清理**旧 DSH**） |
| `module-missing` | `Cannot find module` | 停下，依赖缺失 |
| `permission-disk-memory` | `EACCES`、`ENOSPC`、`ENOMEM` | 停下，环境问题 |
| `crash` | `Segmentation fault`、`Killed` | 重启 |
| `startup-failed` / `plugin-failed` | `entries did not activate`、`failed to apply loader entry` | 重启 |
| `stalled` | 进程在、端口静默超过 `stalledExitMs` | 杀掉僵死进程再启动 |
| `timeout` | 超时未就绪 | 重启 |
| `unknown` | 其它 | 重启 |

每个事件都会写 `incidents/*.json`、`ALERT.md`、一行日志，并按配置发通知。**不自动修复**的情形：非 DSH 进程占着端口、维护窗口内、包树不完整、通配地址绑定、缺模块、权限/磁盘问题、以及开启尊重主动停止时的 `exit(0)`。

## AI 修复（可选，默认关闭）

开启后守护多一档修复手段，分两种模式：

- **act（默认）· 完全权限**：一旦判定服务起不来，先让 AI 直接处理——提示词里附带**当前环境**（端口、宿主 pid/运行时长、node 与 DSH 版本、profile 路径、`cordis.patch.yml` 及最近备份、启动日志路径与大小、端口监听者、诊断与证据、`/proc` 抓到的启动命令），再附上**脱敏后的日志尾部**；AI 可以读文件、改配置、补依赖、回滚 patch、重启服务，随后守护复验端口。**先试 dsh 本体**（`dsh --profile <p> headless "<prompt>"`，继承 DSH 自己的模型凭据与工具权限），再试插件直连（HTTP / 桥接）；两者都不行才回退到原来的规则阶梯（重启 → 回滚 → 人工）。
- **advise · 只判定**：不给动作权限，只回一个 JSON 判定（`retry`/`rollback-patch`/`wait`/`manual`），映射到已有白名单动作；模型输出永远不会被当作命令执行。

安全边界：维护窗口、包树不完整、有真正的监督者（systemd/pm2）时 AI 也不会动手；发送的日志已脱敏，环境变量只发**键名**，密钥与访问令牌不外发；不开启就没有任何外发。硬停与“非 DSH 进程占端口”同样不会被覆盖。

在 **设置 → 重启守护 → AI 修复** 里开启，选择模式与尝试顺序（`dsh-agent-first` / `direct-first` / `dsh-agent-only` / `direct-only`），再配服务商与密钥来源。**密钥默认直接借用 DSH 自己的**：读 `$DSH_HOME/.credentials.yaml` 的 `refs:` 块（`DEEPSEEK_API_KEY`、`XIAOMI_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`），所以即使 `dsh web` 本身起不来，AI 修复仍然可用；也可改成只读环境变量（`ai.credentialSource: "env"`）、只读 DSH 凭据库（`"dsh"`）或指定凭据名（`ai.keyRef`）。密钥只读、不写配置、不落日志。

`ai.dshAgent` 控制“dsh 本体”通道（`command` 默认 `dsh`、`args` 默认 `["headless"]`、`timeoutMs` 默认 300000）。不想让守护直接连 API 时开**桥接**（`ai.bridge`）：提示词写程序 stdin、判定从 stdout 读。点 **测试 AI** 验证链路，命令行等价命令 `dsh-restart-guard ai-test`。

## 配置

全局文件：`$DSH_HOME/restart-guard/config.json`（0600）。设置页可改，watcher 自动重载。

```jsonc
{
  "enabled": true,
  "locale": "auto",
  "watchdog": {
    "probeIntervalMs": 2000,
    "probeTimeoutMs": 3000,
    "startupGraceMs": 30000,
    "bootTimeoutMs": 120000,
    "settleMs": 5000,
    "stalledExitMs": 20000,
    "maxRestartAttempts": 2,
    "rollbackProfilePatch": true,
    "killStaleDshHolder": false,
    "respectIntentionalStop": true,
    "crashLoop": { "windowMs": 600000, "maxIncidents": 3, "pauseMs": 1800000 }
  },
  "maintenance": { "autoDetect": true, "graceMs": 900000, "lookbackMs": 1800000 },
  "logs": { "bootLogPath": "", "mirrorToHostLog": true },
  "ai": {
    "enabled": false, "preset": "deepseek", "endpoint": "", "model": "",
    "keyEnv": "DEEPSEEK_API_KEY", "keyRef": "", "credentialSource": "auto",
    "bridge": { "enabled": false, "program": "", "args": [] }
  },
  "notify": {
    "webhook": { "enabled": false, "preset": "generic", "url": "" },
    "command": { "enabled": false, "program": "", "args": [] },
    "im": { "enabled": false, "botId": "", "targetId": "", "format": "markdown" }
  },
  "supervision": { "mode": "auto" },
  "security": { "allowRemoteMutations": false, "dangerousActions": false }
}
```

`bootLogPath` 通常不需要：宿主健康时守护会从 `/proc/<pid>/fd/1` 抓真实 stdout。若启动器把 stdout 接成管道，再手动指定。

`logs.mirrorToHostLog`（默认 `true`）：守护把自己的日志行以 `[dsh-restart-guard] ` 前缀**追加进宿主的 stdout**（即 `bootLogPath` 或抓到的 stdout 文件），所以容器部署时 `docker logs <container>` 里能直接看到“谁在修、修到哪一步”，不必再进容器翻 `$DSH_HOME/restart-guard/`。它只写这一行前缀，不会伪造 DSH 自己的访问行，就绪判定不受影响。

`supervision.mode` 决定“谁负责重启”：`auto`（默认）识别 systemd、pm2、supervisord 和容器；`none` 表示没有别的程序会重启 DSH，让守护照常动手（适合 CI，或 PID 1 是 systemd 但平台并不会重启服务的容器）；`supervised` 表示只报告、不动手，用于检测不到真正归属者的场景。

- 状态目录 `$DSH_HOME/restart-guard/` 必须能跨重启保留。
- 已有 systemd/pm2 等 supervisor 时，守护只报告，不与 supervisor 抢端口。
- 容器启动器自己会重启 DSH 时，守护在仲裁阶段看到端口恢复就等待，不会起第二个服务。

## 通知渠道

| 渠道 | 配置 | 说明 |
| --- | --- | --- |
| 日志 | 恒开 | `.../instances/<profile>-<port>/restart-guard.log`，5 MB 轮转、保留 2 份 |
| Webhook | `notify.webhook` 或 `DSH_RESTART_GUARD_WEBHOOK_URL` | 预设：`feishu`、`wecom`、`dingtalk`、`slack`、`telegram`、`discord`、`ntfy`、`healthchecks`、`generic` |
| 命令 | `notify.command` | argv 直传（不经过 shell），消息写 stdin |
| IM | `notify.im` 或环境变量 | 需要 `dsh-im` 插件；发不出去先落 outbox，宿主回来后补发 |

消息按事件节流（60 秒），默认附 40 行日志尾部，token/cookie 已脱敏；除非显式开启，不含启动 token 与访问地址。

## CLI

```text
dsh-restart-guard status [--json]      watcher/阶段/健康摘要
dsh-restart-guard doctor               环境体检 + 提示
dsh-restart-guard logs [-f] [-n N]     守护日志
dsh-restart-guard incidents            最近事件
dsh-restart-guard outbox               待补发的 IM 消息
dsh-restart-guard restart|start|rollback|simulate-crash
dsh-restart-guard pause --minutes 30   暂停自动修复
dsh-restart-guard resume
dsh-restart-guard maintenance start|end [--minutes 60] [--reason upgrade]
dsh-restart-guard notify-test          发测试消息
dsh-restart-guard ai-test              征询一次 AI 判定（不执行动作）
dsh-restart-guard reload               重载配置
dsh-restart-guard install|uninstall [--profile web] [--dry-run]
dsh-restart-guard purge                清空全部守护状态
```

CLI 通过控制文件与 watcher 通信（不需要页面 token）；动作需要存活 watcher，否则退出码 3。

## 安全与隐私

- 无遥测。没配渠道就是**零外连**；AI 默认关闭。
- 设置页 API 使用注入到页面壳里的每页 token；变更只接受 POST、动作白名单、请求体 ≤64 KB；远程变更默认拒绝（`security.allowRemoteMutations`）。
- 日志与通知在落盘/外发前脱敏（Webhook URL、IM id、token、cookie、Authorization、常见密钥字段）；环境变量只存**键名**，不存值。
- 数据在 `$DSH_HOME/restart-guard/`：目录 0700、配置与计划 0600；写入不跟随符号链接。

细节见 [SECURITY.md](SECURITY.md)、[PRIVACY.md](PRIVACY.md)。

## 排障

| 现象 | 检查 |
| --- | --- |
| 没有 watcher | `dsh-restart-guard status`；宿主启动后 10 秒内会拉起，插件日志里有 `watcher-spawn` |
| 端口起来了但守护没反应 | 体检里的 `boot-log`：没抓到 stdout 时仍能靠 HTTP 判定，但无法确认新 token |
| 不重启 | 状态是 `maintenance`/`supervised`：升级期和 systemd 下这是预期行为 |
| 反复重启 | state 文件里有诊断；修好后 `resume` |
| IM 没动静 | 先从 设置 → IM Bot 复制 botId/targetId，用“测试通知”验证 |

> QQ 机器人只暴露 `Bot ID`：`targetId` 可以留空，守护会在该 bot 只有一个投递目标时自动使用它；还没有目标时，先和机器人私聊一次（或拉进群），再到 dsh-im 里“新建目标”，然后回到设置页重新扫描。

更多见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 开发

```bash
pnpm install --ignore-scripts
pnpm run typecheck      # tsc --noEmit，无构建步骤
pnpm test               # node:test，含针对假 dsh 的 e2e
pnpm run build:client   # 由 src/client.jsx 重新生成 lib/client.js
node scripts/build-client.mjs --check   # CI：bundle 已提交且是最新
```

架构与不变量见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
