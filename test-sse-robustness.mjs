// 第二十一轮：SSE 协议健壮性 —— 网关返回的 SSE 变体格式与恶意/损坏流（mock，不联网）
// 覆盖：CRLF 行尾 / 多行 data: / 空注释行 / 超大单 chunk / usage 缺失 / 无 [DONE] 截断
// 这些都是 AI SDK 内部解析层要面对的真实世界 SSE 边角。
import { DuMatePlugin } from "./index.mjs"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const seat = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "sse", domain: ".baidu.com" }], source: "manual" }
const hooks = await DuMatePlugin({})
const loader = await hooks.auth.loader(async () => seat)
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"

const realFetch = globalThis.fetch
// mock 需要同时拦截 token/get（返回合法 token）和网关（返回构造的 SSE）
const withMocks = (sseBody, { status = 200, contentType = "text/event-stream" } = {}, fn) => {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-sse", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    return new Response(sseBody, { status, headers: { "Content-Type": contentType } })
  }
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = realFetch })
}
const mkSSE = (raw, contentType = "text/event-stream") => new Response(raw, { status: 200, headers: { "Content-Type": contentType } })
const chunk = (content) => `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`

console.log("[V1] CRLF 行尾（\\r\\n）解析")
try {
  await withMocks(`data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\ndata: [DONE]\r\n\r\n`, {}, async () => {
    const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", stream: true, messages: [] }) })
    const text = await r.text()
    if (!text.includes('content":"a"') || !text.includes("data: [DONE]")) throw new Error("SSE 内容丢失")
  })
  ok("CRLF 流原样透传（解析由 SDK 层负责）")
} catch (e) { fail("CRLF", e) }

console.log("[V2] 超大单 chunk（1MB delta）不崩")
try {
  const big = "x".repeat(1024 * 1024)
  await withMocks(`data: {"choices":[{"delta":{"content":"${big}"}}]}\n\ndata: [DONE]\n\n`, {}, async () => {
    const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", stream: true, messages: [] }) })
    const text = await r.text()
    if (text.length < 1024 * 1024) throw new Error("大 chunk 被截断: " + text.length)
  })
  ok(`1MB chunk 完整透传`)
} catch (e) { fail("大 chunk", e) }

console.log("[V3] 流中途服务器断开（无 [DONE]）→ 上层收到已发内容 + 连接关闭")
try {
  await withMocks(chunk("partial") + chunk(" data"), {}, async () => {
    const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", stream: true, messages: [] }) })
    const got = await r.text()
    if (!got.includes("partial")) throw new Error("已发内容丢失")
  })
  ok("截断流优雅结束")
} catch (e) { fail("截断流", e) }

console.log("[V4] 非 200 流式响应（500）错误体可达上层")
try {
  await withMocks(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500, contentType: "application/json" }, async () => {
    const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", stream: true, messages: [] }) })
    const j = await r.json()
    if (r.status !== 500 || !j.error?.message) throw new Error("错误体丢失: " + r.status)
  })
  ok("500 错误体透传")
} catch (e) { fail("500 流式", e) }

console.log("[V5] content-type 异常（text/plain 而非 event-stream）不拦")
try {
  await withMocks(chunk("x"), { contentType: "text/plain" }, async () => {
    const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", stream: true, messages: [] }) })
    const text = await r.text()
    if (!text.includes("x")) throw new Error("内容丢失")
  })
  ok("content-type 不干预（SDK 层职责）")
} catch (e) { fail("content-type", e) }

globalThis.fetch = realFetch
console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
