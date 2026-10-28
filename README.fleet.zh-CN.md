# Pixel Agents Fleet：多 Agent + SSH 像素办公室

在 Pixel Agents 原有像素办公室上增加了独立的「多 Agent 小队」面板。支持把不同 CLI、不同项目目录、不同远程主机上的任务放在一个办公室里，每次启动一个 Agent 进程，一个进程里的多个对话可以各自对应一个小人。

这是基于上游 `pixel-agents-hq/pixel-agents` 提交 `b1bafd02896d90d83457266575a1e8e5011ce997` 的修改版。保留上游 MIT 许可证与原有界面。新增小队功能在 **standalone 浏览器模式** 使用；VS Code 原有功能保留，但扩展内没有加入小队面板。

## 先玩起来：无需模型、无需 SSH

推荐 Node.js 22 或更新版本。Windows 建议先在 WSL2 中体验；macOS/Linux 可直接运行。从 GitHub 获取源码后，请先安装依赖并构建；原始交付源码包附带构建后的 `dist/`。

```bash
npm ci
npm run build
npm run fleet:demo
```

打开终端打印的完整 URL（保留 `?token=...`），点击左上角 **多 Agent 小队**，选择第一个「演示·一个 Agent 三个对话」，输入任意任务，**只启动一次就会看到三个小人**。演示会让接口对话完成、测试对话继续工作、审查对话等待回复；完成的小人 15 秒后收起，接口对话在第 23 秒重新工作时会以原来的身份回来。也可选择其他环境同时启动更多 Agent。所有动作均为模拟，**不会调用模型或修改你的项目文件**。

## 接真实 Agent

先在运行 Agent 的那台机器上安装并登录相应 CLI，确认直接运行 CLI 正常。应用使用目标机器已有的模型配置和登录状态，不需要把 API Key 填进浏览器。

不带配置文件时，会提供 Claude、Codex、Gemini、OpenCode 四个本地任务配置，工作目录为启动服务的当前目录：

```bash
npm run fleet
```

更推荐复制示例，明确指定你自己的目录和主机：

```bash
cp fleet.example.json fleet.config.json
# 编辑 fleet.config.json，替换 cwd、SSH 别名，删除不需要的条目
npm run fleet -- --fleet fleet.config.json
```

`--fleet` 文件在启动时读取；编辑后重启服务生效。配置文件错误会直接报告，不会悄悄退回默认配置。同一个 profile 可以重复启动，生成多个独立进程分组；同时最多 24 个运行进程，保留最近最多 100 个进程分组。每个进程最多 64 个对话，全局最多 256 个对话（含历史）；达到上限后需移除已结束分组。每个进程和每个对话各保留最近 64,000 字符输出。

## SSH 配置

使用本机 OpenSSH，沿用 `~/.ssh/config`、密钥、ssh-agent、ProxyJump 等现有配置。示例：

```sshconfig
Host dev-box
    HostName 192.0.2.10
    User developer
    IdentityFile ~/.ssh/id_ed25519
    Port 22
```

先在本机终端手动执行 `ssh dev-box`，核对服务器指纹、完成首次连接，并确认远程登录 shell 能找到你的 CLI。然后添加：

```json
[
  {
    "id": "remote-codex",
    "name": "服务器上的 Codex",
    "provider": "codex",
    "mode": "task",
    "ssh": "dev-box",
    "cwd": "/srv/projects/my-app"
  },
  {
    "id": "remote-claude",
    "name": "服务器上的 Claude",
    "provider": "claude",
    "mode": "task",
    "ssh": "dev-box",
    "cwd": "/srv/projects/my-app-review"
  }
]
```

远程要求 POSIX shell 和已安装的 Agent CLI；不需要部署额外的 Web 服务或打开额外端口。`cwd` 必须为绝对路径，不能写 `~/project`。远程命令通过 `sh -lc` 启动；若 CLI 不在其 PATH 中，用 `command` 填远程可执行文件的绝对路径。

SSH 使用 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`：需要密码、未解锁的私钥或未信任的主机将明确失败。应用不会关闭主机密钥校验。服务默认仅监听本机 `127.0.0.1`；查看小队和操作任务均需要终端打印的 token。

## 两种模式

| 模式          | 用法                                        | 小人状态来源                                             |
| ------------- | ------------------------------------------- | -------------------------------------------------------- |
| `task`        | 输入任务，启动 CLI 执行，结束后保留结果     | 解析 JSONL，按会话 ID 分配动作；进程退出结束剩余活跃对话 |
| `interactive` | 打开 CLI 完整终端，继续聊天、审批和执行命令 | 根据终端输出估计活动；安静不代表完成                     |

任务模式内置：

| Provider   | 启动方式                                                      |
| ---------- | ------------------------------------------------------------- |
| `claude`   | `claude --output-format stream-json --verbose -p -- <prompt>` |
| `codex`    | `codex exec --json -- <prompt>`                               |
| `gemini`   | `gemini --output-format stream-json --prompt=<prompt>`        |
| `opencode` | `opencode run --format json -- <prompt>`                      |

默认保留 CLI 自己的权限策略，**不添加跳过审批或沙箱的参数**。任务模式中如果工具权限不足，按该 CLI 的现有配置授权，或改用 `interactive` 在终端操作。可用 `args` 数组加模型选择等 CLI 参数。Claude 另由启动器分配独立 `--session-id`，请勿在 `args` 重复指定。

小队面板按 Agent 进程分组，组内每个对话拥有自己的状态、输出和会话 ID。可以收起或显示单个小人、查看对话历史、打开共享终端、停止整个 Agent、移除已结束分组。浏览器刷新不会中止进程。关闭整个服务会停止它管理的前台进程；本版任务记录只保留在服务内存中，服务重启不恢复任务。

## 一个 Agent 多个对话

- **一个活跃对话一个小人**。状态、工具、输出互不混用，即使两个对话的工具 ID 相同。
- **一个进程一个共享终端**。点击组内任意小人都会打开同一个终端；界面明确标注「共享终端」。
- 小人上方的关闭按钮、面板里的「收起小人」都只隐藏角色，**不会终止进程或其他对话**。隐藏后继续记录输出。
- 「停止整个 Agent（N 个对话）」才会终止该组进程。已完成的对话保留完成状态，其余活跃对话标记停止。没有通用的单对话取消接口，不能把杀进程冒充取消某个对话。
- 完成 / 停止的小人 15 秒后自动收起；失败和明确等待回复的小人保留。自动收起后收到下一轮活动会恢复原角色 ID、颜色和历史；手动收起的小人需手动显示。
- 浏览器刷新会恢复角色状态、共享终端归属和工具动作。进程 / 对话历史目前仅驻留服务内存，服务重启不恢复。

**多对话显示需要可区分的会话 ID。** 单一终端里出现多段文字不代表能可靠识别多个对话。任务模式识别顶层 `session_id`、`thread_id`、`sessionID` 或 `conversationId`。单会话允许后续事件省略 ID；一旦某个进程有多个会话，该进程的每条事件必须带 ID，否则只记入进程日志，不会猜测归属。会话 ID 在所属进程内唯一，不同进程可重用相同 ID。

原生 CLI 是否会在同一进程输出多个会话取决于它自己的运行方式；本改造不会替 CLI 新建多会话能力。默认一次性 CLI 启动通常仍对应一个对话。若你自己的 Agent 在一个进程里管理多个会话，用下面的事件接口最直接。

## 接入已经运行的远程 Agent

若现有 Agent 在 tmux 中，可以接入该终端：

```json
{
  "id": "remote-existing",
  "name": "远程已有会话",
  "provider": "custom",
  "mode": "interactive",
  "ssh": "dev-box",
  "cwd": "/srv/projects/my-app",
  "command": "tmux",
  "args": ["attach-session", "-t", "agents"]
}
```

tmux 的普通终端画面本身不会被自动拆成多个对话；需要额外发送带会话 ID 的事件。此时「停止」只结束 tmux 附着连接，tmux 内的任务仍继续。对于普通 SSH 启动，停止会断开远程 PTY，前台进程通常收到挂断信号；已主动脱离终端、使用 nohup 或其他会话管理器托管的进程不在停止保证范围内。SSH 断网后本次连接会标记失败；本版不自动重连和重放任务，避免重复执行。

## 扩展其他 Agent

`provider: "custom"` 可运行自定义命令。任务模式下，`args` 中**完整等于** `{prompt}` 的参数会替换成用户输入；不会做字符串模板或 shell 拼接展开：

```json
{
  "id": "my-agent",
  "name": "自己的 Agent",
  "provider": "custom",
  "mode": "task",
  "cwd": "/srv/project",
  "command": "/usr/bin/python3",
  "args": ["/srv/agent/main.py", "--task", "{prompt}"]
}
```

让你的程序逐行输出 JSON，可精确驱动角色：

```jsonl
{"type":"tool_start","id":"read-1","name":"Read","input":{"path":"README.md"}}
{"type":"tool_end","id":"read-1"}
{"type":"text","text":"任务进度或结果"}
{"type":"done"}
```

错误使用 `{"type":"error","message":"原因"}`，并退出非零状态。普通文本会进入输出窗口。没有结构化事件的程序仍能运行，但无法提供精确的工具动作。

### 自定义 Agent 的多对话事件

`provider: "custom"` 的程序逐行输出以下 JSONL。同一进程可以交错输出不同 `conversationId`；`title` 可省略，用于角色和面板的显示名称：

```jsonl
{"type":"fleet.event","conversationId":"api","title":"修改接口","event":{"type":"conversation_start"}}
{"type":"fleet.event","conversationId":"tests","title":"运行测试","event":{"type":"conversation_start"}}
{"type":"fleet.event","conversationId":"api","event":{"type":"tool_start","id":"tool-1","name":"Edit","input":{"path":"api.ts"}}}
{"type":"fleet.event","conversationId":"tests","event":{"type":"tool_start","id":"tool-1","name":"Bash","input":{"command":"npm test"}}}
{"type":"fleet.event","conversationId":"api","event":{"type":"tool_end","id":"tool-1"}}
{"type":"fleet.event","conversationId":"api","event":{"type":"text","text":"接口修改完成"}}
{"type":"fleet.event","conversationId":"api","event":{"type":"done"}}
{"type":"fleet.event","conversationId":"tests","event":{"type":"waiting","message":"是否重试失败测试？"}}
```

`conversation_start` / `turn_start` 表示开始新一轮，`done` 结束该对话当前轮次（不代表整个进程退出），`error` 标记该对话失败。下一轮沿用原来的 ID。`waiting` 表示明确等待输入；它只展示状态，不会代替 Agent 实现审批/回复。回复和终止能力由你的 Agent 自己提供。

其他 provider 也可使用 `fleet.event` 包装，内部 `event` 应保持该 provider 的原生事件格式。对于 custom，仅需要上面这一组通用事件。通过 SSH 启动自定义程序时，JSONL 直接随 SSH 标准输出传回，不必新开端口。

### 给正在运行的分组推送事件

启动接口 `POST /api/fleet/runs` 返回的 `id` 是进程 ID；它也出现在面板分组标题。已有进程的集成可以使用 HTTP 事件入口（尤其适用于 `interactive` 模式的旁路遥测）：

```bash
# TOKEN 使用启动服务时打印的 token；RUN_ID 使用实际分组 ID。
# 单条事件也可保存到文件，用 --data-binary @event.json 发送。
curl -X POST "http://127.0.0.1:3000/api/fleet/runs/$RUN_ID/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"type":"fleet.event","conversationId":"api","title":"修改接口","event":{"type":"turn_start"}}'
```

请以启动日志的实际端口替换示例中的 `3000`。该示例对应 custom 分组。交互模式仍保留原始终端；收到带 ID 的遥测后，终端输出不再覆盖各对话状态。未经结构化遥测的交互进程仅显示一个活动估计小人，终端安静不会被当成完成或提问。

接口均要求同一 Bearer token 和可信 Host / Origin：

| 接口                                           | 用途                                     |
| ---------------------------------------------- | ---------------------------------------- |
| `GET /api/fleet`                               | 进程、对话、显示状态快照（不含输出正文） |
| `GET /api/fleet/conversations/:id`             | 单个对话的独立输出                       |
| `POST /api/fleet/conversations/:id/visibility` | `{"visible":false}` 收起、`true` 显示    |
| `GET /api/fleet/runs/:id`                      | 进程汇总日志（包含所有对话）             |
| `POST /api/fleet/runs/:id/events`              | 推送一条 JSON 对话事件，最大 64 KiB      |
| `POST /api/fleet/runs/:id/stop`                | 停止整个进程                             |

## 并行工作的范围

这里提供多 Agent 的启动、显示、终端和生命周期管理，**没有自动的主从调度、消息总线或跨 Agent 任务依赖**。你现有的协作流程可以通过自定义命令接入。多个 Agent 改同一仓库时，建议在 profile 中为它们配置不同的 Git worktree，避免互相覆盖；应用不会替你自动创建 worktree。

Claude 原有发现机制与新增小队并存。小队启动的本地 Claude 会预留会话 ID，避免被原有扫描器重复显示。任意远程机器上已经运行的所有会话不会自动扫描，需通过上述 tmux 方式或在小队中启动。

## 源码与验证

- `core/src/fleet.ts`：配置与任务类型。
- `server/src/fleet/profiles.ts`：配置校验、CLI 参数、SSH 引号处理。
- `server/src/fleet/events.ts`：四种 CLI 与自定义事件适配器。
- `server/src/fleet/service.ts`：进程与会话映射、独立状态/输出、历史和清理。
- `server/src/fleet/routes.ts`：鉴权后的本地 HTTP API。
- `webview-ui/src/components/FleetPanel.tsx`：小队面板。
- `server/__tests__/fleet.test.ts`：新增功能回归测试。

重新构建：

```bash
npm run build
```

如你的容器不支持 tsx CLI 的本地 IPC，可以分别执行等价步骤：

```bash
node --import tsx scripts/generate-messages.ts
npm run check-types
npm run lint
node esbuild.js
npm run build:webview
```

验证命令：

```bash
npm run test:fleet
npm run test:server
npm run test:webview
npm run test:package-contract
# 需要 Linux + 可运行的 sshd，测试仅监听回环地址、使用临时密钥
npm run test:fleet:ssh
# 需要已安装的 Playwright Chromium，先构建 dist
node --import tsx scripts/test-fleet-ui.ts
```

本次验证覆盖 22 项 Fleet 服务测试、2 项角色恢复/终端归属测试，以及浏览器中一次启动三个对话、输出隔离、共享终端、隐藏主小人后刷新恢复、等待状态、分组停止和手机布局。SSH 测试覆盖一条连接里的三个对话。验证使用真实本地 PTY、真实 OpenSSH 客户端，以及临时用户态 SSH 测试服务；Agent 输出由明确标注的模拟程序提供，没有调用收费模型。尚未连接你的服务器，也没有以你的账号验证四种 CLI 的具体安装版本、登录状态和模型权限。不同版本的 JSONL 变化可在 `events.ts` 中适配。

构建、类型检查和打包契约检查通过。完整服务端回归中 746 项通过，1 项上游 CLI 的 `0.0.0.0` 监听测试因当前容器禁止读取网络接口（`uv_interface_addresses`）失败；这项未作为通过计入。前端原有 195 项与新增 2 项通过。Lint 无错误，保留上游 App.tsx 的一个 Hook 依赖警告。

协议参考：

- https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
- https://code.claude.com/docs/en/headless
- https://geminicli.com/docs/cli/headless/
- https://opencode.ai/docs/cli/

### 事件时间线与重启历史（只读）

小队面板的「事件时间线 / 重启历史」可以按进程、对话筛选事件，拖动时间游标查看当时记录的状态。返回实时视图不会启动 Agent、发送终端输入或重新执行工具。此阶段回放是状态列表，不是像素动画回放。

默认仅在内存中保留最近 2,000 条状态事件。若需要重启后历史，在启动服务器前设置 `PIXEL_AGENTS_FLEET_HISTORY_FILE` 为已有私有目录内的日志文件绝对路径（例如自己创建的状态目录中的 `fleet-history.jsonl`）。不要让多个服务器共享同一个文件。未开启持久化时，UI 明确显示「仅本次运行内存记录」。

可选限制：`PIXEL_AGENTS_FLEET_HISTORY_MAX_EVENTS`（默认 2000，上限 10000）、`PIXEL_AGENTS_FLEET_HISTORY_MAX_BYTES`（默认 2097152，上限 8388608）、`PIXEL_AGENTS_FLEET_HISTORY_MAX_DAYS`（默认 7，上限 90）。超过任一限制会移除最早事件并显示历史不完整提示；损坏或半写入的行被跳过，完整行仍可恢复。日志写入失败不影响 Agent，但面板提示新的事件只在内存中。

记录只包含时间、启动批次、进程/对话编号、事件类型、状态和单向哈希的工具引用，不保存任务、路径、会话标识、终端输出或工具参数。「导出状态元数据」只导出上述字段；原始输出导出尚不提供，避免无意泄露凭据。历史中上次服务器的运行中/等待任务显示「执行状态未知 / 已中断待确认」，不会当成当前存活进程；完成的对话仍保持已完成。相同工具 ID 在不同对话中有独立引用。
### SSH 状态与只读诊断

小队面板区分浏览器到服务的连接、SSH 通道证据和 Agent 业务状态。看到输出只表示通道曾有活动；长时间安静不会自动判定失败。SSH 返回 255 或用户停止本地 SSH 时，未完成对话显示“状态未知”，不冒充远端任务已失败/停止，已完成的兄弟对话保持完成。不会自动重连、重跑任务。

选择远程环境后可点击“只读 SSH 诊断”：以现有 SSH 配置和严格主机指纹校验检查连接、工作目录是否可访问、CLI 是否能通过 `command -v` 找到；不执行 CLI、不传入任务参数、不创建密钥。诊断使用非登录 `sh` 的 PATH，如 CLI 仅由交互式 shell 配置添加，请将 profile.command 配成绝对路径。每次最多 12 秒、8 KiB 输出，每个 profile 同时一条诊断、全局最多四条。诊断结果不包含原始 stderr、环境变量或凭据，也不等于确认某个远端任务仍在运行。

真正的跨断线恢复和远端存活探测仍需持久 runner 协议，当前版本明确保留“未知”，避免重复执行。

### 只读工作区改动地图

选择一个进程或对话，在「工作区改动」点击「读取 / 刷新 diff」。启动进程前会采集 Git 基线，区分已有脏文件、运行期间观察到的变化及已消失的变化。已暂存、未暂存和新增文件分别保留状态；同一主机及规范化仓库根目录的进程会显示在一起，多个运行中进程共享脏目录时提示可能重叠修改。**该提示不代表能确认某个对话修改了某个文件**。

读取不执行暂存、提交、回滚或合并。敏感路径（`.env`、私钥等）不返回内容，二进制只显示状态，符号链接不读取目标；普通文件内的秘密仍需自己检查，文件名规则不是完整的秘密检测器。外部 diff、textconv、clean/process filter 和 fsmonitor 被禁用。单次采集上限 8 秒、40 个文件、每文件 8 KiB 差异，超过限制会明确提示；超过 1 MiB 的工作区文件不读取正文。基线不完整时不会声称未记录文件是本任务新增成果。

远程采集沿用严格 SSH 主机密钥校验和 BatchMode，不接受新指纹、不生成密钥、不重跑任务。远端需有 Git、POSIX shell、`realpath` 和 `wc`；缺少这些能力或路径越界时只显示不可读。远端尚未实机验收。启动采集是有界同步读取，极慢远端最多增加 8 秒启动等待；后续读取只由按钮触发。基线随当前 Fleet 服务内存保存，任务结束后仍可查看，移除历史分组或服务重启会丢失基线。
