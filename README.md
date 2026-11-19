# Relay · Local Agent Remote Panel

在 Mac 上运行网关，用 Spare 眼镜看 Codex、Claude Code、Muse、Grok Bot、DeepSeek Harness（dsh）和 Hermes Agent。眼镜是遥控面板：看每个 Agent 的状态，挑一个会话看详情和完整记录，批准或拒绝，对它说话，或者开一个新会话。Nova 的语音接入使用独立令牌，可把话发到面板选中的会话。

## 安装

照 [SETUP.md](SETUP.md) 装。最省事的是把里面那句话发给你 Mac 上的 Claude Code 或 Codex，让它代装；它碰到要你输入 key 或点系统授权时会停下来。下面几节是各部分的细节，装好以后查用。

需要 Node.js 22.13 或更新版本，没有 npm 依赖。在项目目录里 `npm run setup` 生成本机配置 `.env`，`npm start` 在前台跑网关。

Mac 网关监听回环地址，`.env` 仅供本机使用。默认使用标准 Codex App Server，并从本机 Codex 登录读取可用会话。已有共享 App Server 控制套接字时，可将 `PANEL_CODEX_MODE` 改为 `proxy` 并设置 `CODEX_APP_SERVER_SOCKET`。发现的会话仍由原 Codex 进程决定是否允许另一客户端恢复。

## 由 macOS 管理网关

用 `mac/relay.mjs` 打开、关闭和查看网关。先停掉前台的 `npm start`，再把命令链接到 PATH 里：

```sh
ln -s "$PWD/mac/relay.mjs" ~/.local/bin/relay
relay on        # 现在启动，之后每次登录也启动；进程退出后 launchd 会拉起
relay           # 自启开关、网关是否正常、辅助助手、每个 Agent 的连接和会话数
relay restart   # 重启
relay off       # 停止，登录时也不再启动
relay log -f    # 跟踪 data/gateway.log
relay setup     # 列出这台 Mac 上装了哪些 Agent，逐个选要不要启用，写进 .env 的 PANEL_AGENTS
```

网关只运行 `relay setup` 里启用的 Agent，顺序就是眼镜胶囊里的顺序；没跑过 `relay setup` 时一个都不启用，眼镜上会提示。

`relay on` 生成 plist、复制到 `~/Library/LaunchAgents` 并交给 launchd。launchd 启动的是 `relay serve`：它先在 `/private/tmp` 新建辅助助手的信箱（重启后旧信箱会被清掉），启动 `Relay Accessibility.app`，再启动网关。plist 优先用 `/opt/homebrew/bin/node`，因为升级时这个路径不变。

plist 使用绝对路径，移动项目后须重新生成。后台进程若无法读取 Documents 中的项目，可将项目放到本人选定且后台可读的位置后重新生成。[Apple LaunchAgent 指南](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

## 连接 Claude Code

装了 `claude` 命令行（在 PATH 或 `~/.local/bin` 里）时，网关会列出正在运行的会话和最近 14 天关闭的 20 个会话。关闭的会话可以从面板和眼镜回复、批准工具调用；网关在原工作目录后台运行 `claude -p --resume`，Claude 要权限时把请求转到面板，等你批准一次或拒绝。眼镜也能新开会话，放在最近用过的那个目录。正在桌面 app 或终端里开着的会话能看、能批（见下一段），回复要到原窗口，否则同一份记录会有两个写入者，对话会分叉。设 `PANEL_CLAUDE_BIN=off` 可以关掉，也可以填 `claude` 的绝对路径。

开着的会话的审批和状态靠 Claude Code 的钩子：在 `.env` 设 `PANEL_CLAUDE_HOOK_TOKEN`，再在 `~/.claude/settings.json` 给 `UserPromptSubmit`、`PermissionRequest`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionDenied`、`Stop`、`StopFailure`、`SessionEnd` 各加一个 HTTP 钩子，发到 `http://127.0.0.1:4488/hooks/claude`，带 `Authorization: Bearer <这个 token>`；`PermissionRequest` 的 `timeout` 设 600，其余设 5。审批和 Claude 的提问会同时出现在 Claude 的窗口和面板、眼镜上，哪边先答用哪边。提问只有一个时眼镜上能选项或直接说；一次问几个的到面板或原窗口答；计划审批仍在原窗口答。这个 token 只能报会话状态、发起审批，读不了也批不了任何东西。钩子在新开的会话里生效。 [Claude Code hooks](https://code.claude.com/docs/en/hooks)

下面两种是旧的接入方式，仍然可用。网关自动从本机读取已登记会话的状态与 transcript。双向控制使用 Claude Code 官方 Channels。为要接入的会话生成配置，再从该会话的工作目录启动。对正在运行的同一会话，先在原客户端安全结束或退出后再恢复，避免两个写入者。

```sh
node claude-config.mjs <existing-session-uuid>
claude --resume <existing-session-uuid> --mcp-config <generated-config-path> --dangerously-load-development-channels server:relay-panel
```

Claude Code 的交互式开发通道会要求本人确认，组织策略也可能限制。面板回复走 Channel 的 `reply` 工具，工具审批走 Claude Code 的原生转发协议。 [Claude Channels](https://code.claude.com/docs/en/channels-reference)

如果原会话已关闭，也可以用已登录的 Claude CLI 恢复同一个原生会话。先切到该会话原来的工作目录，再运行以下命令。路径指向本项目的私有配置和适配器。

```sh
node --env-file="<project-path>/.env" "<project-path>/claude-stdio.mjs" <existing-session-uuid>
```

这个方式会检查本机登记记录，遇到仍在运行的原会话会停止。接入后可以从面板发消息、查看回复并处理 CLI 转发的工具审批。正在运行的交互式会话使用上面的 Channels 方式。 [Claude Agent SDK 会话](https://platform.claude.com/docs/en/agent-sdk/sessions)

## 连接 Muse 和 Grok Bot

装了 `muse-cli` 和 `gbot` 时，网关用它们接入，不需要打开这两个应用：

- **Muse**：主对话和每个旁支对话都是一个会话，可以回复到指定对话，眼镜能开新的旁支对话。`muse-cli` 每次调用要两秒左右，网关会在后台提前读好记录。
- **Grok Bot**：每个 bot 和群是一个会话，可以回复。Grok 的审批卡片会出现在面板和眼镜上，只能"批准一次"或"拒绝"，不会给永久授权；细节被截断的卡片只能拒绝，批准要回 Grok Bot。不能新开会话。

两个工具的登录各自在命令行里完成。设 `PANEL_MUSE_CLI=off` 或 `PANEL_GBOT_BIN=off` 可以关掉，也可以填绝对路径。命令行出错时，网关退回到下面的辅助功能助手（已配置时）。

打开 Muse 主聊天和 Grok Bot 主 Bot。运行下方命令编译并启动专用 Mac 助手，使用 macOS 辅助功能权限读取指定聊天和发送文字。

```sh
sh mac/build.sh
open -a "$PWD/data/Relay Accessibility.app" --args serve "$(cat data/active-mailbox)" --allow-activation
```

在 macOS 27 的 **System Settings → Privacy & Security → Device Control and Data Access** 中只启用 `Relay Accessibility.app`。较早的版本把这项权限显示为 **Accessibility**。启动参数 `--allow-activation` 允许发送时短暂把目标聊天应用切到前台。桥接按应用与当前主会话匹配，对未识别的编辑器只提供监控。有原生草稿、选错会话或发送结果不确定时，检查原应用中的实际结果。两个应用的原生审批保留在原应用中。

## 连接 DeepSeek Harness（dsh）

dsh 网页版里的会话通过插件 `dsh/relay.mjs` 接入。在 `.env` 设 `PANEL_DSH_TOKEN`（24 位以上的字母、数字、`-`、`_`），重启网关，再在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾加一段（放在其他插件的托管块外面），重启 `dsh web`：

```yaml
- insert:
    - id: relay
      name: /绝对路径/dsh/relay.mjs
      config:
        gateway: http://127.0.0.1:4488
        token: <PANEL_DSH_TOKEN>
```

面板上能看到 dsh 正在跑和最近的 20 个会话、读记录、发消息（排在当前这轮之后）、停止当前这轮。dsh 的审批和提问同时出现在 dsh 窗口和面板上，哪边先答用哪边；面板上的批准只算这一次。插件只在网关连得上时参与，网关没开时 dsh 照常只在自己窗口里问。插件在本机随机端口开一个只认网关的接口，凭每次启动重新生成的密钥访问；这个 token 只能报状态、发起审批。还没有会话消息的空会话、子 Agent 的会话不列出。眼镜上 DeepSeek 是第五个图标，用法和 Claude Code 一样，也能从眼镜新开会话。

## 连接 Hermes Agent

在 `relay setup` 里启用 Hermes 就行，不用装插件。网关只读 Hermes 的会话库（`~/.hermes/state.db`，`HERMES_HOME` 可改），列你自己开的会话（不含子任务、定时、看板、webhook）：在跑的全列，空闲的列最近 20 个。说话、新开会话、停止、审批和 Hermes 的追问走 `hermes acp`（编辑器接 Hermes 用的同一个接口），网关第一次需要时启动它。正在跑时说的话排到这一轮结束后再发。审批卡按 Hermes 给的选项提供允许、本会话都允许、拒绝；追问只能选 Hermes 给的选项。卡片 10 分钟没人回，审批算拒绝、追问算跳过。找不到 `hermes` 命令时用 `PANEL_HERMES_BIN` 指定路径。

## Spare 眼镜

眼镜应用 Relay 直接请求你在 Spare App 里接入的 Agent，也就是这个网关，不经过 Spare 的托管中转。

1. 网关要有一个手机能到达的固定 HTTPS 地址（例如 Cloudflare Tunnel），只对外开放 `/v1/`。做法见 [SETUP.md](SETUP.md) 第 6 步。
2. 在 Spare App「设置 › 开发者功能 › 接入自己的 Agent」填入这个地址和本机 `PANEL_NOVA_TOKEN`。网关在 `/v1/spare/agent` 回应握手，`/v1/spare/app/*` 给眼镜应用，`/v1/spare/events` 推送静默画面的变化和提醒。Nova 仍走 `/v1/chat/completions`，模型名 `agent-panel`。
3. 在眼镜上装 Relay（Spare 创意工坊）。自己改眼镜应用的话，源码在 `spare/`：在创意工坊建开发应用，运行 `node spare/prepare.mjs <app-id>` 生成可提交的文件，推到应用仓库后用云端构建和模拟器检查。应用需要 `agent` 和 `microphone` 两个权限。
4. 待机时镜片上只有一个小胶囊：等你的 Agent 图标闪，在跑的亮，空闲的暗；哪个会话说了新的话，胶囊下面长出一张卡片。单击打开目录：第一项是新建会话，下面是所有会话，按最近动静排，转表冠选、单击进去。会话页像终端，最新的话在最底下，往上转看历史，在最底下单击说话回复。Agent 要批准或问你选择题时从胶囊弹出来。待机往下转进总管。
5. 网关记下眼镜请求带来的应用 ID，用它推送列表更新。想固定应用 ID 可以在 `.env` 设 `PANEL_SPARE_APP_ID`。iPhone 的推送地址同样从请求里记下，只在眼镜没有连着事件流时使用，不写日志。

待机往上转表冠进空屏：镜片上什么都不显示，眼镜不刷新、不发请求，网关也停止往眼镜推送；Mac 上的网关和总管照常工作。空屏往下转回到待机，往上转进总管，这时在总管底部往下转回空屏。

没有推送时，眼镜每 5 秒刷新一次。手机断开时显示「等待连接」，没接入 Agent 时显示「没接 Agent」。 [Spare 开发者指南](https://spare.cool/dev/docs) · [接入自己的 Agent](https://spare.cool/io/agent/)

## 总管

总管是网关自己的 Agent：它看着所有会话，替你派活、催进度、收汇报，自己不写代码。眼镜待机时往下转表冠进总管的页面，单击说话；它有新汇报时胶囊最左边的图标会亮，待机冒出一张汇报卡片。开新会话、打断会话这类动作它会先问你，眼镜上弹出「好 / 不要」；会话等你批准时，它只在你开口说了「好」「不行」「选第二个」「你帮我选」之后才替你回答。

总管默认用 OpenCode Go 的模型，走 OpenAI 兼容的 `/chat/completions` 接口；想换别家，改 `lib/zongguan/model.mjs` 里的地址、key 的读法和请求头。把 OpenCode 的 key 存进钥匙串（命令会提示你输入 key）：

```sh
security add-generic-password -s relay-opencode -a opencode -w
```

钥匙串里没有时，网关再看 `.env` 的 `PANEL_OPENCODE_KEY`。都没有，总管显示「没配好」，其余功能不受影响。

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `PANEL_ZONGGUAN` | 开 | 设 `off` 关掉总管 |
| `PANEL_ZONGGUAN_MODEL` | `deepseek-v4.1-flash` | OpenCode Go 的模型名 |
| `PANEL_ZONGGUAN_EFFORT` | `high` | 思考档位（`reasoning_effort`）；deepseek-v4.1-flash 有 `low` / `high` / `max` |
| `PANEL_ZONGGUAN_COMPACT_AT` | `300000` | 上下文到多少 token 自动压缩，至少 10000 |

总管的对话存在网关数据库里，自动压缩；也可以直接说「压缩一下」「清空历史」。你让它记住的规矩写在 `data/zongguan.md`，可以直接编辑。

网关发给 Claude Code 的话末尾带一个回执号「〔Relay 回执 xxxxxx〕」，总管转述的话还附上你的原话。在本机运行 `node bin/relay-receipt.mjs <回执号>`，能查到这句话是你在眼镜上亲口说的还是总管转述的、原话是什么；想让 Claude 会话收到时自己核对，可以在你的 `~/.claude/CLAUDE.md` 里加一条规则让它先跑这个命令。

## 测试

```sh
npm test
RELAY_TEST_CODEX_BIN="$(command -v codex)" npm test
npm run test:launchd
```

测试使用回环网络与临时数据库。第二条命令另外运行真实 Codex App Server，模型响应由测试固定。
