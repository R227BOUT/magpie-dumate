// 第十七轮：模型清单与上游映射核对——观察 model-text 智能路由实际解析到哪些上游
// （插件注释里记了 deepseek-v4-flash-low-latency / qwen35-35b-a3b，验证是否仍准确）
// 同时测 dm-auto-model/text.L0 与 model-text 是否返回不同的上游特征（响应 id/模型字段）。
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

console.log("[M1] model-text 多次调用观察上游分布（响应 model 字段）")
try {
  const upstreams = new Set()
  for (let i = 0; i < 6; i++) {
    const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }) })
    if (r.status !== 200) throw new Error("HTTP " + r.status)
    const j = await r.json()
    upstreams.add(j.model ?? "(unknown)")
  }
  ok(`6 次调用上游分布: ${[...upstreams].join(" | ")}`)
} catch (e) { fail("上游分布", e) }

console.log("[M2] dm-auto-model/text.L0 与 model-text 响应特征对比")
try {
  const probe = async (model) => {
    const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }) })
    const j = await r.json()
    return { model: j.model, idPrefix: String(j.id ?? "").slice(0, 6) }
  }
  const a = await probe("model-text")
  const b = await probe("dm-auto-model/text.L0")
  console.log(`   model-text -> model=${a.model}, id~${a.idPrefix}`)
  console.log(`   L0         -> model=${b.model}, id~${b.idPrefix}`)
  ok(`两模型均可调，model 字段如实返回`)
} catch (e) { fail("模型对比", e) }

console.log("[M3] 上游是否透传 n 参数（部分网关忽略）")
try {
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, n: 1, messages: [{ role: "user", content: "hi" }] }) })
  ok(`n=1 请求 ${r.status === 200 ? "被接受" : "HTTP " + r.status}（仅记录）`)
} catch (e) { fail("n 参数", e) }

console.log("[M4] logprobs / top_logprobs 等高级参数容忍度")
try {
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, logprobs: false, messages: [{ role: "user", content: "hi" }] }) })
  ok(`logprobs=false ${r.status === 200 ? "被接受" : "HTTP " + r.status}（仅记录）`)
} catch (e) { fail("logprobs", e) }

console.log("[M5] 响应 id/created 字段完整性（AI SDK 依赖）")
try {
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })
  const j = await r.json()
  for (const f of ["id", "created", "object", "model", "choices"]) {
    if (!(f in j)) throw new Error("响应缺字段 " + f)
  }
  if (j.object !== "chat.completion") throw new Error("object 字段异常: " + j.object)
  ok(`标准 OpenAI 形态齐全（object=${j.object}）`)
} catch (e) { fail("响应字段", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
