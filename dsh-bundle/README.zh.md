# Tabby 串口 MCP（DeepSeek Harness 侧）

让 agent 在你**正开着的 Tabby 串口窗口**里收发原始字节，也能自己开新串口页。

这个包是 DSH 侧的连接器：装上它，Harness 会自动连上本机 Tabby 插件暴露的 MCP 服务，并注册一个
`tabby-serial` 技能，告诉 agent 串口入口在哪、怎么读写。

> 串口 I/O 本身不在这里，而在 Tabby 插件
> [`tabby-serial-mcp`](https://www.npmjs.com/package/tabby-serial-mcp) 里。本 bundle 只负责“连上去 + 教它怎么用”。

## 它装了什么

| 行 | 作用 |
|---|---|
| `tabby-serial-skill` | 注册 `tabby-serial` 技能：串口入口、读写循环、设备怪癖与人机共用端口的礼仪 |
| `tabby-serial-mcp` | 用官方 `@deepseek-ai/dsh-mcp-client` 连接 `http://127.0.0.1:3002/mcp` |

装上后工具以 `mcp__tabby__serial_*` 出现，在会话里可以直接调。

## 前置条件

Tabby 里要装好 `tabby-serial-mcp` 插件，并且 Tabby 正在运行：

```powershell
Invoke-RestMethod http://127.0.0.1:3002/health
```

返回 `running: true` 就绪。插件没装或 Tabby 没开时，这个 bundle 只是不断重连，不会拖住 DSH 启动——
mcp-client 行配了 `failOnStartupError: false` 和 200 次重连。

## 安装

```text
plugin_manager install_bundle  target: dsh-tabby-serial
```

固定版本写 `dsh-tabby-serial@1.0.2`；也可以从仓库装（钉 commit）：

```text
plugin_manager install_bundle  target: github:Wazy-XD/tabby-serial-mcp#path:/dsh-bundle
```

卸载：

```text
plugin_manager remove_bundle  target: dsh-tabby-serial
```

## 工具

| 工具 | 作用 |
|---|---|
| `serial_list_ports` | 列本机串口（型号、序列号、vid:pid） |
| `serial_list_tabs` | 列 Tabby 里打开的串口页，`id` 就是后续的 `target` |
| `serial_open` | 新建串口页（端口/波特率/数据位/停止位/校验） |
| `serial_close` | 关页并释放端口 |
| `serial_status` | 单页状态、收发字节数、缓冲偏移 |
| `serial_write` | 写原始字节：`data`（`\r\n\xNN` 转义）或 `hex` |
| `serial_read` | 读字节，`timeoutMs` 长轮询，`as: hex/text/auto` |
| `serial_expect` | 等正则；带 `write` 时**先武装匹配再发字节**，快回包不会漏 |
| `serial_annotate` | 只在窗口里打一行提示，不发给设备 |

## 配置

默认就够用。要改端口或换地址，在本 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: tabby-serial-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: tabby
    transport: streamable-http
    url: http://127.0.0.1:3002/mcp
```

`serverName` 决定工具前缀（`mcp__<serverName>__serial_*`）。

## 排错

- **工具没出现**：先确认 `http://127.0.0.1:3002/health` 返回 `running: true`；再看 Tabby 的
  `%APPDATA%\tabby\serial-mcp.log`。
- **连上但读写失败**：多半是标签页 `rendered: false`（Tabby 恢复出来但没点开）或端口被别的程序占用。
- **重启后技能不见**：技能由 Host 行注册，改完 bundle 需要重新 `install_bundle` 或重启 DSH。

## 许可证

MIT。
