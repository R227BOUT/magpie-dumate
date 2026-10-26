// 第十六轮 A：稳定性心跳监测（后台跑，每 60s 一次 usage 快照 + 低频 chat 探针，共 ~20 分钟）
// 输出到 JSONL 供事后分析：积分漂移 / token 会话稳定性 / 错误率。
import { DuMatePlugin } from "./index.mjs"
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs"
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

const outDir = join(here2(), "stability-logs")
function here2() { return new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") }
mkdirSync(outDir, { recursive: true })
const logFile = join(outDir, `heartbeat-${Date.now()}.jsonl`)

const DURATION_MS = 20 * 60 * 1000
const INTERVAL_MS = 60 * 1000
const start = Date.now()
let beat = 0
let errors = 0

console.log(`[H] 稳定性心跳启动：每 ${INTERVAL_MS / 1000}s 一拍，共 ${DURATION_MS / 60000} 分钟 → ${logFile}`)

while (Date.now() - start < DURATION_MS) {
  beat++
  const ts = new Date().toISOString()
  const entry = { beat, ts }
  try {
    // usage 快照
    const u = await hooks.auth.usage(async () => seat)
    if (u.error) { entry.usageError = u.error; errors++ }
    else {
      entry.balance = u.balance
      entry.usedPct = u.windows?.[0]?.used
      entry.readAt = u.readAt
    }
  } catch (e) { entry.usageError = e.message; errors++ }

  // 每 3 拍（3 分钟）发一次轻量 chat 探针（~0.02 积分/次，总 <0.3）
  if (beat % 3 === 1) {
    try {
      const res = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 32, stream: false, messages: [{ role: "user", content: `心跳${beat}，回复ok` }] }) })
      entry.chatStatus = res.status
      if (res.status !== 200) errors++
    } catch (e) { entry.chatStatus = "ERR:" + e.message.slice(0, 50); errors++ }
  }

  entry.cumulativeErrors = errors
  appendFileSync(logFile, JSON.stringify(entry) + "\n")
  console.log(`  [${beat}] ${ts.slice(11, 19)} balance=${entry.balance ?? "ERR"} chat=${entry.chatStatus ?? "-"} cumErr=${errors}`)

  const next = start + beat * INTERVAL_MS
  await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())))
}

console.log(`\n[H] 心跳结束：${beat} 拍，累计错误 ${errors}`)
console.log(`[H] 日志: ${logFile}`)
process.exitCode = errors > 2 ? 1 : 0
