# 安装 Relay 网关

Relay 是 Spare 眼镜上的一个应用：在眼镜上看 Mac 里的 Codex、Claude Code、Muse、Grok Bot、DeepSeek（dsh）和 Hermes Agent 在干什么，批准、回答、说话、开新会话，还有一个替你盯着它们的「总管」。眼镜应用连的是你自己 Mac 上的这个网关。

**最省事的装法**：在 Mac 上打开 Claude Code 或 Codex，把下面这句话发给它。它会照这份说明一步步装，碰到要你输入密码、key 或点系统授权的地方会停下来告诉你。

```text
照 https://github.com/Mmohet/spare-relay/blob/main/SETUP.md 帮我在这台 Mac 上装好 Relay 网关，每一步做完都核对一下。
```

自己装也一样：按下面的顺序做。

---

## 给代装的 Agent

你在替用户装一个本机网关。照这几条做：

- 密码、API key、登录、macOS 的授权弹窗都由用户自己完成。到这些步骤时停下来，说清楚要用户做什么、在哪做，等用户说好了再往下。
- 改用户已有的配置文件（`~/.claude/settings.json`、dsh 的插件配置）前先备份，只往里加 Relay 那几项，不覆盖别的内容。
- 不要把令牌打印到对话里。要用户填进手机时，用 `pbcopy` 复制到剪贴板。
- 每一步都有核对命令，跑过、结果对了再进下一步；不对就停下来告诉用户卡在哪。
- `relay setup` 要在终端里交互回答，你的 shell 不是终端时它只会列出检测结果。这时先问用户要启用哪些 Agent，再直接改 `.env` 里的 `PANEL_AGENTS`（见第 3 步）。

## 1. 准备

- macOS，Node.js 22.13 或更新：`node -v`。
- Spare 眼镜和手机上的 Spare App，眼镜上装好 Relay（Spare 创意工坊里搜 Relay）。
- 至少一个下面列出的 Agent 已经在这台 Mac 上能用。

## 2. 取代码、生成本机配置

放在后台进程读得到的位置，不要放在「文稿」「桌面」「下载」里（macOS 会挡住后台进程读这些目录）：

```bash
git clone https://github.com/Mmohet/spare-relay.git ~/relay
cd ~/relay && npm run setup
```

`npm run setup` 生成 `.env`（只有本人可读），里面有网关的几个随机令牌。没有要装的 npm 依赖。

核对：`test -f ~/relay/.env && echo ok`

## 3. 接哪些 Agent

每个 Agent 先满足条件，再启用。用户不用的跳过。

| Agent | 条件 | 核对 |
|---|---|---|
| Codex | 装了 `codex` 命令行并登录 | `codex login status` |
| Claude Code | 装了 `claude` 命令行并登录；另外加钩子（见下面） | `claude --version` |
| Muse | `uv tool install muse-cli`，按 muse-cli 的说明登录 | `muse-cli status` |
| Grok Bot | `npm i -g grok-bot-cli`，Grok Bot 应用在这台 Mac 上登录着 | `gbot doctor --json` 里 `grokBotAppSession.usable` 是 `true` 才能从眼镜发消息，否则只能看 |
| DeepSeek（dsh） | 装了 `dsh`，用网页版；另外装插件（见下面） | `dsh --version` |
| Hermes Agent | 装了 `hermes` 命令行 | `hermes --version` |

选好后启用。在终端里可以交互选：

```bash
cd ~/relay && node mac/relay.mjs setup
```

或者直接写 `.env`（顺序就是眼镜胶囊里的顺序，键名是 `codex` `claude` `muse` `grok` `dsh` `hermes`）：

```bash
cd ~/relay && grep -q '^PANEL_AGENTS=' .env && sed -i '' 's/^PANEL_AGENTS=.*/PANEL_AGENTS=codex,claude/' .env || echo 'PANEL_AGENTS=codex,claude' >> .env
```

### Claude Code 的钩子

没有钩子也能看 Claude Code 的会话、从眼镜开新会话；加了钩子，正在桌面 app 或终端里开着的会话，它的状态、审批和提问才会实时到眼镜上。

1. 生成一个令牌写进 `.env`：

   ```bash
   cd ~/relay && echo "PANEL_CLAUDE_HOOK_TOKEN=$(openssl rand -hex 32)" >> .env
   ```

2. 备份 `~/.claude/settings.json`，然后在 `hooks` 下给这 9 个事件各加一条 HTTP 钩子：`UserPromptSubmit`、`PermissionRequest`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionDenied`、`Stop`、`StopFailure`、`SessionEnd`。`PermissionRequest` 的 `timeout` 是 600，其余是 5。每条长这样（`<令牌>` 换成上一步 `.env` 里的值，已有的钩子保留）：

   ```json
   { "hooks": [ { "type": "http", "url": "http://127.0.0.1:4488/hooks/claude", "headers": { "Authorization": "Bearer <令牌>" }, "timeout": 5 } ] }
   ```

3. 钩子只在新开的 Claude Code 会话里生效。这个令牌只能报状态、发起审批，读不了也批不了任何东西。

核对：`python3 -c "import json,os; h=json.load(open(os.path.expanduser('~/.claude/settings.json')))['hooks']; print(sum('hooks/claude' in json.dumps(v) for v in h.values()))"` 输出 `9`。

### DeepSeek（dsh）的插件

1. 生成令牌写进 `.env`：

   ```bash
   cd ~/relay && echo "PANEL_DSH_TOKEN=$(openssl rand -hex 24)" >> .env
   ```

2. 备份 `~/.dsh/profiles/web/cordis.patch.yml`，在文件末尾加一段（放在其他插件的托管块外面；路径换成 `~/relay` 的绝对路径，令牌换成上一步的值），然后重启 `dsh web`：

   ```yaml
   - insert:
       - id: relay
         name: /Users/<你>/relay/dsh/relay.mjs
         config:
           gateway: http://127.0.0.1:4488
           token: <PANEL_DSH_TOKEN>
   ```

## 4. 总管（可选）

总管默认用 OpenCode Go 的模型（`deepseek-v4.1-flash`）。让用户自己把 key 存进钥匙串，命令会提示输入：

```bash
security add-generic-password -s relay-opencode -a opencode -w
```

没有 key 时总管显示「没配好」，其余功能照常。想换别家的模型：总管走的是 OpenAI 兼容的 `/chat/completions` 接口，地址、key 的读法和 OpenCode 专用的请求头都在 `lib/zongguan/model.mjs`，可以让你的 Agent 照你要用的服务改；模型名和思考档位用 `.env` 的 `PANEL_ZONGGUAN_MODEL`、`PANEL_ZONGGUAN_EFFORT` 设。

## 5. 让网关在后台常驻

```bash
mkdir -p ~/.local/bin && ln -sf ~/relay/mac/relay.mjs ~/.local/bin/relay
relay on
```

`relay on` 交给 macOS 的 launchd 管：现在启动，以后每次登录自动启动，进程退出会被拉起。其他命令：`relay`（看状态）、`relay restart`、`relay off`、`relay log -f`。

核对：

```bash
curl -s http://127.0.0.1:4488/health
relay
```

第一条输出 `{"ok":true}`；第二条里每个启用的 Agent 都是连上的状态。

## 6. 给网关一个手机能访问的 HTTPS 地址

手机要从外面连到这台 Mac。地址要固定，网关重启后不能变。下面是 Cloudflare Tunnel 的做法，需要一个 Cloudflare 账号和一个托管在 Cloudflare 上的域名；ngrok、Tailscale Funnel 之类能给固定 HTTPS 地址、转发到 `127.0.0.1:4488` 的也行。

```bash
brew install cloudflared
cloudflared tunnel login                 # 浏览器里登录 Cloudflare，用户自己完成
cloudflared tunnel create relay
cloudflared tunnel route dns relay relay.<你的域名>
```

再写 `~/relay/data/cloudflared-relay.yml`（隧道 ID 和凭证文件路径见 `cloudflared tunnel create` 的输出）。只放行 `/v1/`，其余路径一律 404：

```yaml
tunnel: <隧道 ID>
credentials-file: /Users/<你>/.cloudflared/<隧道 ID>.json
no-autoupdate: true
ingress:
  - hostname: relay.<你的域名>
    path: ^/v1/
    service: http://127.0.0.1:4488
  - service: http_status:404
```

这个文件在，`relay` 就会在网关旁边自动跑 cloudflared。运行 `relay restart`。

核对（令牌从 `.env` 读，不打印）：

```bash
cd ~/relay && curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(grep '^PANEL_NOVA_TOKEN=' .env | cut -d= -f2-)" https://relay.<你的域名>/v1/spare/agent
```

输出 `200`。

## 7. 在手机上接入

1. 把令牌复制到剪贴板：

   ```bash
   cd ~/relay && grep '^PANEL_NOVA_TOKEN=' .env | cut -d= -f2- | tr -d '\n' | pbcopy
   ```

2. 手机打开 Spare App：**设置 › 开发者功能 › 接入自己的 Agent**。「Agent 地址」填 `https://relay.<你的域名>`，「Token」粘贴刚才复制的令牌，点「测试连接」。
3. 「Agent 接管 AI 助手」开关 Relay 用不到，保持关闭就行；打开后眼镜自带的 AI 助手也会改走这个网关。

## 8. 在眼镜上看

打开 Relay：待机时镜片上只有一个小胶囊，启用的每个 Agent 一个图标，在跑的亮、空闲的暗，等你批准或回答的会闪。单击打开会话目录。

| 眼镜上看到 | 原因 |
|---|---|
| 没接 Agent | 第 7 步没填，或者地址、令牌不对 |
| 等待连接 | 手机和眼镜没连上 |
| 某个 Agent 看不到会话，或者发不出话 | 那个 Agent 没连上：在 Mac 上跑 `relay` 看状态，`relay log -f` 看原因 |
| 总管显示「没配好」 | 第 4 步的 key 没存 |

## 可选：Claude Code 核对回执

网关发给 Claude Code 的话末尾带一个回执号「〔Relay 回执 xxxxxx〕」。运行 `node ~/relay/bin/relay-receipt.mjs <回执号>` 能查到这句话是你在眼镜上亲口说的，还是总管转述的、原话是什么。想让 Claude 会话收到时自己核对，可以在你的 `~/.claude/CLAUDE.md` 里加一条规则，让它先跑这个命令。
