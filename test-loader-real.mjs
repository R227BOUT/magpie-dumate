// 第四轮：loader 的 Request 对象路径 / stream+tools 组合 / refresh hook 行为
import { DuMatePlugin, _internal } from "./index.mjs"
import { readFileSync } from "node:fs"
import { createDecipheriv } from "node:crypto"
import { join } from "node:path"

const dir = join(process.env.APPDATA ?? "", "qianfan-desktop-app")
const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))
const key = readFileSync(join(dir, ".cookie-key"))
const buf = Buffer.from(auth.cookies, "base64")
const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
d.setAuthTag(buf.subarray(12, 28))
const cookies = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"))

const seat = { type: "oauth", cookies, source: "desktop", accountId: "a", name: "t" }
const getAuth = async () => seat
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const hooks = await DuMatePlugin({})
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"

console.log("[R1] loader 收 Request 对象（AI SDK 的真实调用形态）")
try {
  const l = await hooks.auth.loader(getAuth)
  const req = new Request(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "should-be-stripped" },
    body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
  const res = await l.fetch(req)
  if (res.status !== 200) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 150))
  const j = await res.json().catch(() => ({}))
  if (!j.choices) throw new Error("no choices")
  ok(`Request 对象 -> 200，choices 正常`)
} catch (e) { fail("Request 对象路径", e) }

console.log("[R2] loader 收 (url, init) 形态（另一类 SDK 用法）")
try {
  const l = await hooks.auth.loader(getAuth)
  const res = await l.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
  if (res.status !== 200) throw new Error("HTTP " + res.status)
  ok("(url, init) 形态 -> 200")
} catch (e) { fail("url+init 路径", e) }

console.log("[R3] stream:true + tools 组合（agent 最真实场景）")
try {
  const l = await hooks.auth.loader(getAuth)
  const res = await l.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "model-text", max_tokens: 512, stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
      messages: [{ role: "user", content: "请用工具读取 C:/tmp/x.txt 的内容" }],
    }),
  })
  if (res.status !== 200) throw new Error("HTTP " + res.status)
  const text = await res.text()
  let toolCallDelta = false, contentDelta = false, done = false, tcName = "", tcArgs = ""
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (data === "[DONE]") { done = true; continue }
    const j = JSON.parse(data)
    const delta = j.choices?.[0]?.delta ?? {}
    if (delta.tool_calls?.length) {
      toolCallDelta = true
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) tcName = tc.function.name
        if (tc.function?.arguments) tcArgs += tc.function.arguments
      }
    }
    if (delta.content) contentDelta = true
  }
  if (!done) throw new Error("no [DONE]")
  if (!toolCallDelta) throw new Error("expected streamed tool_calls, got content-only")
  const args = JSON.parse(tcArgs || "{}")
  ok(`流式 tool_calls: ${tcName}(${JSON.stringify(args)}) 正确分片重组`)
} catch (e) { fail("stream+tools", e) }

console.log("[R4] refresh hook：desktop seat + 本机 Cookie 未变 -> undefined（不折腾）")
try {
  const r = await hooks.auth.refresh(seat)
  if (r !== undefined) throw new Error("expected undefined, got: " + JSON.stringify(r).slice(0, 100))
  ok("Cookie 未变 -> 不刷新")
} catch (e) { fail("refresh 未变", e) }

console.log("[R5] refresh hook：desktop seat + 本机 Cookie 已变 -> 跟随新 Cookie")
try {
  // 构造旧 seat：把其中一条 cookie 值改掉，模拟"客户端重登后 auth.json 更新"
  const stale = { ...seat, cookies: cookies.map((c, i) => (i === 0 ? { ...c, value: c.value + "stale" } : c)) }
  const r = await hooks.auth.refresh(stale)
  if (r === undefined) throw new Error("expected new auth, got undefined")
  if (!Array.isArray(r.cookies) || r.cookies.length !== cookies.length) throw new Error("cookie count mismatch")
  if (r.source !== "desktop") throw new Error("source should stay desktop")
  ok(`跟随新 Cookie（${r.cookies.length} 条），source 保持 desktop`)
} catch (e) { fail("refresh 跟随", e) }

console.log("[R6] refresh hook：browser seat（非 desktop）-> undefined（不打扰粘贴凭据）")
try {
  const browserSeat = { ...seat, source: "browser" }
  const r = await hooks.auth.refresh(browserSeat)
  if (r !== undefined) throw new Error("expected undefined for browser seat")
  ok("browser seat -> 不刷新")
} catch (e) { fail("refresh browser", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
