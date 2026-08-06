# AI8-Hub 增量性能优化包设计

- 日期：2026-08-06
- 范围：连接速度 (TTFT)、流式吞吐与平滑度、响应体积压缩、高并发稳定性
- 约束：不改变任何现有接口/行为，增量低风险，现有 69 个测试保持全绿

## 背景

AI8-Hub 是 OpenAI/Anthropic 兼容网关，转发到 AI8 上游、gpt-all 独立渠道及自定义渠道。用户希望在功能不变的前提下优化性能。

### 现状（已核实）

- 上游请求全部走 Node 原生 `fetch`（undici），全局 dispatcher 使用默认配置（keep-alive 4s），高频下反复 TLS 握手。
  - `lib/ai8-client.js:462`、`lib/gptall-client.js:346`、`lib/channel-manager.js:63/288`
- 无任何响应压缩。`/v1/models`（数百模型）与 admin JSON 全明文传输。
- 模型/模板缓存已存在但无启动预热：
  - 模板缓存 TTL 300s：`lib/ai8-client.js:15-37`
  - 聚合模型缓存 TTL 5min：`lib/channel-manager.js:20-24`
- SSE 解析使用字符串拼接 `buffer += decoder.decode(...)`，长流为 O(n²)：
  - `lib/ai8-client.js:263`、`lib/gptall-client.js:213`
- 流式每个 token 立即 `res.write`（`server.js:1783`），未启用 TCP_NODELAY。
- 每个请求都 `logger.info`（`server.js:1472`），高并发下日志 I/O 开销可观。

## 优化项

### 1. 上游连接池化（TTFT + 并发）

**目标**：复用上游 TCP/TLS 连接，减少握手，降低首字延迟。

**方案**：
- 新增依赖 `undici`。
- 新建 `lib/http-pool.js`：启动时调用
  `setGlobalDispatcher(new Agent({ keepAliveTimeout, connections, connect: { timeout } }))`。
- 全局 dispatcher 自动作用于进程内所有 `fetch`，无需改动任何调用点（Express 服务端不受影响）。
- 参数可被 env 覆盖：`HTTP_POOL_CONNECTIONS`、`HTTP_KEEPALIVE_TIMEOUT`、`HTTP_CONNECT_TIMEOUT`。
- 默认值：keepAliveTimeout 60000ms、connections 64、connect.timeout 10000ms。

**验证**：连接池配置解析单测；保持连接复用的冒烟验证（两次请求日志显示同一连接/无握手）。

### 2. 响应压缩（响应体积）

**目标**：缩小大 JSON 响应体积，加快传输。

**方案**：
- 新增依赖 `compression`。
- 中间件 `app.use(compression({ threshold: 1024 }))`，仅压缩 >1KB 响应，保护 `/health` 等小响应。
- 流式 SSE 路径已设置 `Cache-Control: no-cache, no-transform`（`server.js:814`），`compression` 对 `no-transform` 自动跳过压缩，流式不受影响。
- JSON 响应（`/v1/models`、admin API）约缩小 10-20 倍。

**验证**：`/v1/models` 带 `Accept-Encoding: gzip` 返回压缩内容且内容等价；SSE 响应不带 `content-encoding`。

### 3. 模型/模板缓存预热（TTFT）

**目标**：避免首个请求冷启动等待模型列表。

**方案**：
- 服务器启动后（`server.js` listen 回调）与配置保存成功后，fire-and-forget 调用
  `fetchAggregatedModels(client, config, false, logger, false)` 预热聚合模型缓存，
  `client.fetchTemplate()` 预热模板缓存。
- 预热失败仅记 warning，不影响启动。

**验证**：启动后立即请求 `/v1/models` 命中缓存（不触发上游拉取）；预热失败时服务器仍正常。

### 4. SSE 解析器微优化（流式吞吐）

**目标**：避免长流 O(n²) 字符串拼接。

**方案**：
- `lib/ai8-client.js:262-276` 与 `lib/gptall-client.js:212-226` 的 SSE 解析改为
  **索引游标 + 周期性裁剪**：用 `readOffset` 记录已消费位置，仅在裁剪时机执行 `buffer.slice`，
  语义与现有逐字节边界查找完全一致。

**验证**：现有 AI8/gptall 流式单测全绿；长流（10k+ 事件）解析结果与旧实现逐字节一致。

### 5. 流式写传输优化（平滑度）

**目标**：消除 Nagle 延迟，token 到达更跟手。

**方案**：
- 流开始处（`server.js:813-819` 附近）`if (res.socket) res.socket.setNoDelay(true)`。
- 包体积不变，无行为变化。

**验证**：流式响应正常，客户端感知 token 到达更平滑。

### 6. 请求日志降噪（高并发，可选）

**目标**：减少高并发下日志 I/O。

**方案**：
- 新增 env `LOG_SLOW_THRESHOLD_MS`（默认 0 = 全记，保持现状）。
- `requestLoggerMiddleware`（`server.js:1465-1481`）在阈值 >0 时，仅记录
  duration >= 阈值或 status >= 400 的请求。
- 配置项加入 runtime-config（env 读取，非 editable）。

**验证**：默认行为不变（全记）；设置阈值后慢请求/错误仍记录。

## 不做（超出本次范围）

- 流式背压控制（客户端慢时暂停上游读取）：需重构 `ai8-client` 回调结构，列为后续中等深度优化。
- cluster 多进程、HTTP/2、Brotli：改动大风险高，暂缓。

## 风险与验证

- 全部为增量改动，现有 69 个测试必须全绿。
- 新增单测：http-pool 配置解析、SSE 解析器等价性。
- 部署：服务器 `git pull` + `npm install` + `pm2 restart ai8-hub`。

## 相关文件

- 新增：`lib/http-pool.js`、`docs/superpowers/specs/2026-08-06-performance-optimization-design.md`
- 修改：`server.js`（压缩中间件、预热、NODELAY、日志降噪）、`lib/runtime-config.js`（新 env）、
  `lib/ai8-client.js`（SSE 解析）、  `lib/gptall-client.js`（SSE 解析）、`package.json`（undici、compression）、
  `.env.example`（新 env 文档）
- 无 UI 变更：日志阈值仅通过 env 配置，后台页面不改动
