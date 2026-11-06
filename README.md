# koishi-plugin-foxy-memory-bridge

把 DSH 里 Foxy 的对话写入 ChatLuna [`koishi-plugin-chatluna-livingmemory`](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory)，并在下一轮把记忆召回给 DSH。

这是 `dsh-foxy-memory` 的可选桥。没有这个桥时，DSH 侧的 Foxy 仍然可以用本地 JSONL 记忆；装上桥之后，DSH 与 QQ 可以共用 `foxy3（Character）` 记忆池。

## 链路

```text
DSH session (foxy preset)
  └─ dsh-foxy-memory (provider: livingmemory)
       └─ HTTP POST /foxy-memory/record
            └─ koishi-plugin-foxy-memory-bridge
                 └─ ctx.chatluna_living_memory.createMemory(...)
                      └─ LivingMemory SQLite + PGlite 索引
```

读取时反向走 `/foxy-memory/context`，桥调用 `searchMemories()`，为空时退回 `listMemories()`。

桥不会直接 INSERT `koishi.db`，所以 speaker key、profile、向量索引都由 LivingMemory 自己维护。

## 安装

Koishi 实例内：

```powershell
cd C:\Users\MECHREV\AppData\Roaming\Koishi\Desktop\data\instances\default
npm install "D:\path\to\koishi-plugin-foxy-memory-bridge"
```

然后在 Koishi 控制台启用 `foxy-memory-bridge`。它依赖：

- `koishi` ^4.18
- `koishi-plugin-chatluna-livingmemory`（peer，未安装时插件不会加载）

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `path` | `/foxy-memory` | HTTP 路由前缀 |
| `token` | 空 | Bearer token；留空时只允许本机回环访问 |
| `presetId` | `foxy3（Character）` | 读写哪个 LivingMemory preset |
| `platform` | `dsh` | speakerKey 的平台名 |
| `userId` | `2242711967` | 人类用户 ID（kunfox） |
| `userLabel` | `kunfox` | 人类显示名 |
| `assistantId` | `2877932816` | Foxy 的 ID |
| `assistantLabel` | `Foxy` | Foxy 显示名 |
| `conversationPrefix` | `dsh:` | 生成 conversationId 的前缀 |
| `maxContext` | `20` | 单次最多返回多少条 |

公网/局域网部署时务必设置 `token`。留空只适合 DSH 与 Koishi 在同一台机器。

## DSH 侧配置

`dsh-foxy-memory` 的插件配置：

```yaml
provider: livingmemory
bridgeUrl: http://127.0.0.1:5140/foxy-memory
bridgeToken: 与桥的 token 相同
bridgePresetId: foxy3（Character）
```

`bridgeUrl` 填到 `/foxy-memory` 为止，不要带 `/record`。配置后默认使用桥；桥失败会自动回退本地 JSONL，不会丢消息。

## API

### `POST /foxy-memory/record`

```json
{
  "role": "user",
  "text": "kunfox 今天在 DSH 做了插件",
  "sessionId": "session-...",
  "presetId": "foxy3（Character）"
}
```

写一条 `type: "context"` 的记忆，content 形如：

```text
kunfox 在 DSH 说：kunfox 今天在 DSH 做了插件
```

### `POST /foxy-memory/context`

```json
{ "query": "DSH 插件", "limit": 20, "presetId": "foxy3（Character）" }
```

返回：

```json
{ "ok": true, "count": 3, "text": "- [2026-11-06 20:00] [DSH] ...", "memories": [] }
```

### `GET /foxy-memory/health`

返回 `{ ok, presetId, platform, path, service }`，可用于探活。

## 鉴权

- 设置 `token` 后，请求必须带 `Authorization: Bearer <token>` 或 `X-Foxy-Token: <token>`。
- 未设置 `token` 时只接受 `127.0.0.1` / `::1` 的请求。
- 桥不会把 token 写入日志。

## 限制

- 写入依赖 LivingMemory 的 `createMemory`，所以必须是有效 preset；`foxy3（Character）` 不存在时会返回 500 和提示。
- 召回走 `searchMemories`，向量索引未建立时可能为空，此时桥退回 `listMemories` 最近记录。
- 记忆内容按“DSH 侧的一句话”写入，不做 LLM 摘要/合并；这与 LivingMemory 的 Dream/摘要流程是互补的。
- 桥只处理 Foxy 的 DSH 对话；QQ 侧仍由 ChatLuna 原管线负责。

## 测试

```powershell
node test/test-bridge.cjs
```

测试使用 mock LivingMemory service，不连接真实实例。

## License

MIT
