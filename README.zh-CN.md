# tabby-serial-mcp

[English](README.md) · **中文**

把 **Tabby 里已经打开的串口标签页**通过 [MCP](https://modelcontextprotocol.io) 暴露给 AI agent：
agent 可以读写原始字节，也可以自己新建串口页。

关键在于它**不做什么**：它不会去开第二个 COM 口。串口的所有权仍然在 Tabby 手里，插件只是挂到那个
活的 `SerialSession` 上，于是你和 agent 共用同一条连接。你照常在那个窗口里敲字，agent 每次发送都会在
窗口里留下一行暗色的 `[agent → N B] …`。

```
AI agent ── mcp__tabby__serial_* ──► http://127.0.0.1:3002/mcp
                                          │  （Tabby 插件：tabby-serial-mcp）
                                          ▼
                              Tabby SerialSession  ──►  你的串口设备
                                          ▲
                                    你在这里敲键盘
```

## 为什么不直接用现成的串口 MCP 服务？

普通串口 MCP 服务必须自己 `open()` 端口，而串口是独占的：agent 一占上，你 Tabby 里的窗口就用不了。
这个插件把关系反过来——端口留在 Tabby，agent 拿到的是字节流的旁路。

## 环境要求

- Tabby 1.0.23x（在 1.0.238 / Windows 上验证）。插件只依赖 `tabby-core` / `tabby-terminal` 的公开
  API，不需要构建。
- Tabby 内置的 Node 18+。
- 可选：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，仓库里的 `dsh-bundle/`
  是现成的连接配置；其它能说 streamable HTTP 的 MCP 客户端也可以直接连。

## 安装

### 1. Tabby 插件

```powershell
# Windows：下载最新 release 并重启 Tabby
iwr -useb https://raw.githubusercontent.com/Wazy-XD/tabby-serial-mcp/main/scripts/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Wazy-XD/tabby-serial-mcp/main/scripts/install.sh | bash
```

手工安装：从[最新 release](../../releases/latest)下载 `tabby-serial-mcp.zip`，解压到 Tabby 插件目录，
目录名保持 `tabby-serial-mcp`：

| 系统 | 路径 |
|---|---|
| Windows | `%APPDATA%\tabby\plugins\node_modules\` |
| macOS | `~/Library/Application Support/tabby/plugins/node_modules/` |
| Linux | `~/.config/tabby/plugins/node_modules/` |

重启 Tabby。`http://127.0.0.1:3002/health` 应返回 `running: true`，Tabby 设置里会多出一页
**串口 MCP**（状态、端口、回显开关、重启服务）。

### 2. MCP 客户端

任何 streamable-HTTP 的 MCP 客户端都可以连 `http://127.0.0.1:3002/mcp`。

用 DeepSeek Harness 的话，`dsh-bundle/` 是一个配置型 bundle，把官方 `@deepseek-ai/dsh-mcp-client`
接到这个地址。直接从仓库装：

```
plugin_manager install_bundle github:Wazy-XD/tabby-serial-mcp#path:/dsh-bundle
```

走 git 解析，会把具体 commit 钉进 profile 的锁文件——不是本地路径，也不是软链。以后要升级到新 commit，
先 `remove_bundle dsh-tabby-serial` 再装一次。也可以用 release 里的 `dsh-tabby-serial.zip`，或者手写：

```yaml
- insert:
    - id: tabby-serial-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tabby
        transport: streamable-http
        url: http://127.0.0.1:3002/mcp
        toolCallTimeoutMs: 60000
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 1000
          maxDelayMs: 30000
          maxAttempts: 200
```

工具名形如 `mcp__tabby__serial_*`。

## 工具

| 工具 | 作用 |
|---|---|
| `serial_list_ports` | 列串口（路径、厂商、序列号、vid:pid） |
| `serial_list_tabs` | 列已打开的串口页；返回的 `id` 就是其它工具的 `target` |
| `serial_open` | 新建串口页（端口、波特率、数据位、停止位、校验、标题） |
| `serial_close` | 关页并释放端口 |
| `serial_status` | 单个页的端口、线路参数、收发字节数、缓冲偏移 |
| `serial_write` | 写原始字节：`data`（支持 `\r\n\xNN` 转义）或 `hex` |
| `serial_read` | 读字节；`timeoutMs` 长轮询，`as: auto/text/hex` |
| `serial_expect` | 等正则；带 `write`/`hex` 时**先武装匹配再发字节**，快回包不会漏 |
| `serial_annotate` | 只在窗口里打一行提示，永远不发给设备 |

`target` 可以写标签页 id（`s1`）、端口名（`COM13`）；只有一个串口页时可以省略。

## 用法

```
serial_list_ports
serial_open   { "port": "COM13", "baudRate": 115200 }
serial_write  { "data": "AT+CSQ\r\n" }
serial_read   { "timeoutMs": 1000 }
```

一问一答的设备用这一条就够：

```
serial_expect { "pattern": "\\+CSQ: *\\d+,\\d+", "timeoutMs": 3000, "write": "AT+CSQ\r\n" }
```

读取是游标式的：`serial_read` 返回 `from`/`to` 两个绝对流偏移，把 `from` 传回去就能幂等地重读一段；
`bufferStart` 告诉你最早还留有数据的偏移。

## 配置

`%APPDATA%\tabby\serial-mcp.json`（设置页会自动写）：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 开机启动 MCP 服务 |
| `host` | `127.0.0.1` | 绑定地址（只绑回环，设计如此） |
| `port` | `3002` | MCP 端口 |
| `echoAgentWrites` | `true` | 在窗口里打印暗色的 `[agent → N B]` |
| `ringBufferBytes` | `4194304` | 每个标签页的接收缓冲 |
| `maxReadBytes` | `1048576` | 单次 `serial_read` 上限 |

日志：`%APPDATA%\tabby\serial-mcp.log`（超过 2 MB 轮转）。Tabby 的渲染进程控制台默认看不到，所以插件
加载失败时先看这个文件。

## 排查

```powershell
Invoke-RestMethod http://127.0.0.1:3002/health          # 服务活着吗
Get-Content "$env:APPDATA\tabby\serial-mcp.log" -Tail 40 # 走到哪一步了
Get-NetTCPConnection -LocalPort 3002                    # 端口被谁占了
```

浏览器打开 <http://127.0.0.1:3002/> 有一张状态页。

## 已知限制

- **只缓冲插件挂上之后的字节。** 插件启动前已经在标签页里刷过去的数据不在环形缓冲里（`bufferStart`
  是最早可用偏移）。
- **没被显示过的标签页没有 session。** Tabby 恢复出来但没点开的串口页会显示 `rendered: false`，点开一次
  即可；`serial_open` 创建的页面会自动激活。
- **一个 COM 口只能被一个标签页持有**，`serial_open` 撞上会失败并说明原因。
- **只绑回环、无鉴权**，和 Tabby 本身的信任模型一致，不要暴露到网络。
- 只在 Windows 上验证过；`install.sh` 里 macOS/Linux 的路径遵循 Tabby 的 userData 约定，但未实测。
- 服务实现的是 2025 系 MCP 握手（对 2026-07-28 的 `server/discover` 探测回 `-32601` 让客户端回落），
  已用 `@modelcontextprotocol/client` 2.2.0 验证。

## 开发

```
tabby-plugin/     Tabby 插件（纯 CommonJS，无需构建）
  index.js        NgModule + APP_INITIALIZER
  lib/bridge.js   配置、注册表、MCP 服务生命周期、开关标签页
  lib/sessions.js 串口页发现、原始字节环形缓冲、read/expect
  lib/ring.js     按绝对偏移寻址的字节环形缓冲
  lib/tools.js    9 个 MCP 工具
  lib/mcp-server.js  基于 node:http 的 streamable-HTTP JSON-RPC 服务
  lib/settings-tab.js Tabby 设置页（中/英，跟随 Tabby 语言）
dsh-bundle/       DeepSeek Harness 配置型 bundle
test/             协议回归测试（真 MCP SDK + 假 Tabby 注册表）
```

改完插件后，把 `tabby-plugin/` 覆盖到已安装目录（`.../plugins/node_modules/tabby-serial-mcp`）并重启
Tabby。

协议测试：

```bash
cd test
npm install
node protocol-test.mjs
```

它会用真 MCP SDK 起真服务，覆盖初始化、工具列表、文本/hex 写入、读取、expect（含"先武装再发"路径）、
超时和错误映射。

## 许可证

MIT，见 [LICENSE](LICENSE)。
