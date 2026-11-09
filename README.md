# koishi-plugin-foxy-memory-bridge

> **DEPRECATED / 已停止维护**
>
> 本插件已被 [`koishi-plugin-chatluna-foxy-memory`](https://github.com/Kun-Fox/koishi-plugin-chatluna-foxy-memory) 取代，不再增加新功能，也不再做兼容性修复。
>
> 新部署请直接使用 `koishi-plugin-chatluna-foxy-memory`；它保留 `chatluna_living_memory` 兼容服务名，并提供 `/foxy-memory/*` HTTP API。已有部署请先导出旧记忆，再导入新插件，确认对账后停用本桥。迁移说明见新插件 README 的“迁移旧数据”一节。
>
> 本 README 仅作为历史实现与迁移参考保留。

把 DSH 里 Foxy 的对话写入 ChatLuna LivingMemory，并在下一轮把记忆召回给 DSH。

这是 `dsh-foxy-memory` 的旧可选桥，依赖已退役的 `koishi-plugin-chatluna-livingmemory`。新插件已内置等价的 DSH HTTP 直连接口，不需要再运行本桥。

从 0.1.15 起，桥还可以让 DSH 侧的 Foxy 通过 QQ 机器人主动发送私聊；0.1.16 起，事件会携带 `platform / channelType / channelId / eventType`，记忆不再被强行改写。这些能力现已由新插件的 `/foxy-memory/send-private` 与事件化记忆接口承接。

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
corepack yarn add "koishi-plugin-foxy-memory-bridge@file:./koishi-plugin-foxy-memory-bridge-0.1.16.tgz"
```

Yarn 4 必须写成 `包名@file:路径`；装完在 Koishi 控制台启用 `foxy-memory-bridge`。它依赖：

- `koishi` ^4.18
- `koishi-plugin-chatluna-livingmemory`（peer，未安装时插件不会加载）

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `path` | `/foxy-memory` | HTTP 路由前缀 |
| `token` | 空 | Bearer token；留空时只允许本机回环访问 |
| `presetKind` | `character` | `character` 用 Character 预设，`chatluna` 用主插件预设 |
| `chatlunaPresetId` | `preset` | ChatLuna 主插件预设（动态下拉） |
| `characterPresetId` | `preset` | Character 预设（动态下拉；自动补 `（Character）`） |
| `presetId` | `preset（Character）` | 兼容旧配置；实际由上面两项计算 |
| `extractModel` | `deepseek/deepseek-flash` | 批量提取记忆用的 ChatLuna 模型 |
| `platform` | `dsh` | speakerKey 的平台名 |
| `userId` | `10001` | 人类用户 ID（用户） |
| `userLabel` | `用户` | 人类显示名 |
| `assistantId` | `2877932816` | Foxy 的 ID |
| `assistantLabel` | `Foxy` | Foxy 显示名 |
| `botId` | 空 | 发送私聊使用的机器人 selfId；留空优先 `assistantId` |
| `conversationPrefix` | `dsh:` | 生成 conversationId 的前缀 |
| `maxContext` | `20` | 单次最多返回多少条 |
| `standalonePort` | `0` | 大于 0 时额外监听独立端口，避免 Koishi Console 的 SPA 路由吞掉 `/foxy-memory/*` |

公网/局域网部署时务必设置 `token`。留空只适合 DSH 与 Koishi 在同一台机器。

如果 Koishi Console 先注册了 SPA 路由导致 `/foxy-memory/health` 返回控制台 HTML，把 `standalonePort` 设为 `5141`，DSH 侧把 `bridgeUrl` 改为 `http://127.0.0.1:5141/foxy-memory`。

## DSH 侧配置

`dsh-foxy-memory` 的插件配置：

```yaml
provider: livingmemory
bridgeUrl: http://127.0.0.1:5140/foxy-memory
bridgeToken: 与桥的 token 相同
bridgePresetId: preset（Character）
```

`bridgeUrl` 填到 `/foxy-memory` 为止，不要带 `/record`。配置后默认使用桥；桥失败会自动回退本地 JSONL，不会丢消息。

## API

### `POST /foxy-memory/ingest`

DSH 侧每积累一批消息后调用；桥用 `extractModel` 把对话提炼成中文、Foxy 第一人称的长期记忆，再逐条写入 LivingMemory。请求可带 `platform / channelType / channelId / eventType / sourceLabel`，桥会按真实事件类型记录，不再把所有场景强行改写成“我刷到”。

```json
{
  "sessionId": "session-...",
  "presetId": "preset（Character）",
  "messages": [
    { "role": "user", "text": "昨天群里聊了什么？", "at": 1790000000000 },
    { "role": "assistant", "text": "外设那摊，轨迹球和短屁股鼠标喵", "at": 1790000001000 }
  ]
}
```

返回 `{ ok, presetId, created, ids }`。空内容或模型判断没有值得长期保存的信息时返回 `created: 0`，不会写流水账。

`/record` 仍保留，用于兼容旧版或手工写单条；新版 DSH 批处理只调用 `/ingest`。

### `POST /foxy-memory/record`

```json
{
  "role": "user",
  "text": "用户 今天在 DSH 做了插件",
  "sessionId": "session-...",
  "presetId": "preset（Character）"
}
```

写一条 `type: "context"` 的记忆，content 形如：

```text
用户 在 DSH 说：用户 今天在 DSH 做了插件
```

### `POST /foxy-memory/context`

```json
{ "query": "DSH 插件", "limit": 20, "presetId": "preset（Character）" }
```

返回：

```json
{ "ok": true, "count": 3, "text": "- [2026-11-06 20:00] [DSH] ...", "memories": [] }
```

### `POST /foxy-memory/send-private`

让 QQ 机器人给指定用户发一条私聊。DSH 侧用于把有趣的 B 站视频主动推给主人；发送成功后，DSH 侧会再写一条 `scene: "private"` 的私聊记忆。

```json
{
  "userId": "10001",
  "text": "我刷到一个视频，觉得你会喜欢。",
  "selfId": "2877932816"
}
```

`userId` 可省略，默认使用桥配置的 `userId`；`selfId` 可省略，优先 `botId`/`assistantId`。返回 `{ ok, userId, botId, messageIds }`。

### `GET /foxy-memory/health`

返回 `{ ok, presetId, platform, path, service }`，可用于探活。

## 鉴权

- 设置 `token` 后，请求必须带 `Authorization: Bearer <token>` 或 `X-Foxy-Token: <token>`。
- 未设置 `token` 时只接受 `127.0.0.1` / `::1` 的请求。
- 桥不会把 token 写入日志。

## 限制

- 写入依赖 LivingMemory 的 `createMemory`，所以必须是有效 preset；`preset（Character）` 不存在时会返回 500 和提示。
- 召回走 `searchMemories`，向量索引未建立时可能为空，此时桥退回 `listMemories` 最近记录。
- 记忆内容按“DSH 侧的一句话”写入，不做 LLM 摘要/合并；这与 LivingMemory 的 Dream/摘要流程是互补的。
- 桥只处理 Foxy 的 DSH 对话；QQ 侧仍由 ChatLuna 原管线负责。

## 测试

```powershell
node test/test-bridge.cjs
```

测试使用 mock LivingMemory service 和 mock 机器人，不连接真实实例，也不会真的发 QQ。

`test/test-route.cjs` 另外验证 HTTP 路由，包括 `/send-private`。

## License

MIT

