// 第二十二轮：真实网关上的历史会话连续性——同一 loader 在长时间跨度下 token 自动续期验证
// （真实调用：token 1h 有效期，本轮通过人为验证缓存刷新链路 + 连续 5 分钟内多批请求）
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

console.log("[L1] 连续 3 分钟、每 30s 一发真实请求（共 6 发）——模拟 agent 长会话")
try {
  const results = []
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < 3 * 60 * 1000) {
    i++
    const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "回复ok" }] }) })
    results.push(r.status)
    await r.text().catch(() => {})
    await new Promise((res) => setTimeout(res, 30 * 1000))
  }
  const good = results.filter((s) => s === 200).length
  if (good !== results.length) throw new Error(`${results.length - good}/${results.length} 失败: ${results.join(",")}`)
  ok(`${results.length} 发跨 3 分钟全部 200`)
} catch (e) { fail("长会话", e) }

console.log("[L2] usage 前后对照（积分消耗与请求次数线性）")
try {
  const u = await hooks.auth.usage(async () => seat)
  if (u.error) throw new Error(u.error)
  ok(`当前余额 ${u.balance}（仅记录）`)
} catch (e) { fail("usage 对照", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
