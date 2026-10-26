// 第十九轮：性能基线 —— token 获取延迟分布 / 首字节时间 TTFB / 端到端延迟分位数
import { DuMatePlugin } from "./index.mjs"
import { readFileSync, writeFileSync } from "node:fs"
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

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)
  return Math.round(s[Math.max(0, i)])
}
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }
const report = { token: [], nonstream: [], streamTTFB: [], streamTotal: [] }

// [P1] token 获取延迟（清缓存后每次实测 token/get 单程）
console.log("[P1] token 获取延迟 ×5（清缓存强制重取）")
for (let i = 0; i < 5; i++) {
  // 用不同 cookieHeader 强制绕过缓存（等价真实"冷启动"）
  const s = { type: "oauth", cookies: [...cookies, { name: `__p${i}`, value: `${i}`, domain: ".perf.local" }], source: "desktop" }
  const l = await hooks.auth.loader(async () => s)
  const t0 = performance.now()
  const r = await l.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })
  const ms = performance.now() - t0
  report.token.push(ms)
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  await r.text()
}
console.log(`  token 链路（含 chat）: p50=${pct(report.token, 50)}ms p95=${pct(report.token, 95)}ms`)

// [P2] 非流式端到端延迟 ×8
console.log("[P2] 非流式端到端 ×8")
for (let i = 0; i < 8; i++) {
  const t0 = performance.now()
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 16, stream: false, messages: [{ role: "user", content: "回复ok" }] }) })
  await r.text()
  report.nonstream.push(performance.now() - t0)
}
console.log(`  非流式: p50=${pct(report.nonstream, 50)}ms p95=${pct(report.nonstream, 95)}ms min=${Math.round(Math.min(...report.nonstream))}ms max=${Math.round(Math.max(...report.nonstream))}ms`)

// [P3] 流式 TTFB（首 chunk 到达）×8
console.log("[P3] 流式 TTFB ×8")
for (let i = 0; i < 8; i++) {
  const t0 = performance.now()
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 64, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "数到五" }] }) })
  const reader = r.body.getReader()
  let ttfb = null, total = null
  while (true) {
    const { done, value } = await reader.read()
    if (ttfb === null && value) ttfb = performance.now() - t0
    if (done) break
  }
  total = performance.now() - t0
  report.streamTTFB.push(ttfb)
  report.streamTotal.push(total)
}
console.log(`  TTFB: p50=${pct(report.streamTTFB, 50)}ms p95=${pct(report.streamTTFB, 95)}ms`)
console.log(`  流式总时长: p50=${pct(report.streamTotal, 50)}ms`)

// 健康门槛：TTFB p95 < 5s、非流式 p95 < 10s（超了说明网关/插件有异常慢路径）
try {
  const ttfbP95 = pct(report.streamTTFB, 95)
  const nsP95 = pct(report.nonstream, 95)
  if (ttfbP95 > 5000) fail("TTFB p95", `${ttfbP95}ms > 5s`)
  else if (nsP95 > 10000) fail("非流式 p95", `${nsP95}ms > 10s`)
  else ok(`性能门槛通过（TTFB p95=${ttfbP95}ms, 非流式 p95=${nsP95}ms）`)
} catch (e) { fail("性能门槛", e) }

const summary = {
  ts: new Date().toISOString(),
  tokenChainMs: { p50: pct(report.token, 50), p95: pct(report.token, 95) },
  nonstreamMs: { p50: pct(report.nonstream, 50), p95: pct(report.nonstream, 95), min: Math.round(Math.min(...report.nonstream)), max: Math.round(Math.max(...report.nonstream)) },
  streamTTFBMs: { p50: pct(report.streamTTFB, 50), p95: pct(report.streamTTFB, 95) },
  streamTotalMs: { p50: pct(report.streamTotal, 50) },
}
writeFileSync("perf-baseline.json", JSON.stringify(summary, null, 2))
console.log("\n[基线已写入 perf-baseline.json]")
console.log(JSON.stringify(summary, null, 2))
