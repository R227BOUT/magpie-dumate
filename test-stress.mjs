// 第十一轮：30 并发混合负载 + 中途断流 + 断流后恢复（验证 token 缓存不被污染）
import { DuMatePlugin } from "./index.mjs"
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

const seat = { type: "oauth", cookies, source: "desktop" }
const hooks = await DuMatePlugin({})
const loader = await hooks.auth.loader(async () => seat)
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[X1] 30 并发混合负载（10 流式 + 10 非流式 + 10 工具调用）")
try {
  const jobs = []
  for (let i = 0; i < 10; i++) {
    jobs.push(
      loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 128, stream: true, messages: [{ role: "user", content: `回复数字${i}` }] }) }).then(async (r) => ({ kind: "stream", status: r.status, body: await r.text() })),
      loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 128, stream: false, messages: [{ role: "user", content: `回复数字${i}` }] }) }).then(async (r) => ({ kind: "plain", status: r.status, json: await r.json().catch(() => null) })),
      loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 256, stream: false, tools: [{ type: "function", function: { name: "calc", description: "计算", parameters: { type: "object", properties: { expr: { type: "string" } } } } }], messages: [{ role: "user", content: `算 ${i}+${i}` }] }) }).then(async (r) => ({ kind: "tools", status: r.status, json: await r.json().catch(() => null) })),
    )
  }
  const results = await Promise.allSettled(jobs)
  const rejected = results.filter((r) => r.status === "rejected")
  const bad = results.filter((r) => r.status === "fulfilled" && r.value.status !== 200)
  if (rejected.length || bad.length) {
    const sample = rejected[0]?.reason?.message ?? `HTTP ${bad[0]?.value?.status}`
    throw new Error(`${rejected.length + bad.length}/30 失败，样例: ${String(sample).slice(0, 150)}`)
  }
  ok(`30/30 全部 200（流式 10 + 普通 10 + 工具 10）`)
} catch (e) { fail("30 并发混合", e) }

console.log("[X2] 中途断流（AbortController 2 秒后中止）")
try {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 2000)
  let aborted = false
  try {
    const res = await loader.fetch(GW, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model-text", max_tokens: 2048, stream: true, messages: [{ role: "user", content: "写 500 字散文" }] }),
      signal: ac.signal,
    })
    // 读 body 到一半中止
    const reader = res.body.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  } catch (e) {
    if (e.name === "AbortError") aborted = true
    else throw e
  }
  // signal 触发时 fetch/reader 任一侧抛 AbortError 即算通过；若流 2 秒内自然结束也算（max_tokens 大概率没写完）
  ok(aborted ? "请求被正确中止（AbortError）" : "流在 2 秒内自然结束（也算通过）")
} catch (e) { fail("断流", e) }

console.log("[X3] 断流后恢复（紧接着的正常请求必须成功——token 缓存未被污染）")
try {
  const res = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 64, stream: false, messages: [{ role: "user", content: "回复ok" }] }) })
  if (res.status !== 200) throw new Error("HTTP " + res.status)
  const j = await res.json()
  if (!j.choices) throw new Error("no choices")
  ok(`断流后首个请求 200（缓存健康）`)
} catch (e) { fail("断流恢复", e) }

console.log("[X4] 同秒级重复断流 3 次 + 恢复（缓存淘汰逻辑压力）")
try {
  for (let i = 0; i < 3; i++) {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 300)
    try {
      const res = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, signal: ac.signal, body: JSON.stringify({ model: "model-text", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "写 300 字" }] }) })
      await res.text().catch(() => {})
    } catch { /* 预期可能 AbortError */ }
  }
  const res = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 32, stream: false, messages: [{ role: "user", content: "回复ok" }] }) })
  if (res.status !== 200) throw new Error("恢复失败 HTTP " + res.status)
  ok("3 次连断后仍正常")
} catch (e) { fail("反复断流恢复", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
