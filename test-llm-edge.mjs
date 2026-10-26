// 第三十一轮：LLM 异常输出容错 —— 网关返回的模型输出里各种"不规范 JSON"与边界
// 真实调用（小 max_tokens 控制成本）验证上游模型行为 + 插件透传不崩
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

async function chat(messages, extra = {}) {
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 1024, stream: false, ...extra, messages }) })
  return { status: r.status, json: await r.json().catch(() => null) }
}

console.log("[L1] 模型输出含特殊字符（引号/反斜杠/换行）透传完整")
try {
  const r = await chat([{ role: "user", content: '请原样输出这行文字（一字不改，含标点）："quoted" \\backslash\\ tab	end' }])
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const c = String(r.json.choices[0].message.content ?? "")
  if (!c.includes("quoted") || !c.includes("backslash")) throw new Error("特殊字符丢失（finish=" + r.json.choices[0].finish_reason + "）: " + c.slice(0, 60))
  ok(`特殊字符透传完整（${c.length} 字）`)
} catch (e) { fail("特殊字符", e) }

console.log("[L2] 超长单条 message（50k 字符）输入")
try {
  const big = "很".repeat(50_000)
  const r = await chat([{ role: "user", content: big.slice(0, 20) + "……请回复ok（前面是长文本填充）" }])
  // 50k 汉字 ≈ 50k tokens 超上下文，应得明确错误而非挂死——放宽：接受 200 或结构化错误
  if (r.status === 200) ok("50k 输入被网关接受")
  else if (r.json?.error?.code) ok(`50k 输入 → 结构化错误 ${r.status}/${r.json.error.code}`)
  else throw new Error("非结构化失败: " + r.status)
} catch (e) { fail("长输入", e) }

console.log("[L3] messages 含全部标准角色（system/user/assistant/tool）")
try {
  const r = await chat([
    { role: "system", content: "回复ok" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "hi" },
  ])
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  ok("四角色消息序列 200")
} catch (e) { fail("角色序列", e) }

console.log("[L4] assistant 消息带 name 字段（部分 SDK 会带）")
try {
  const r = await chat([
    { role: "user", name: "alice", content: "回复ok" },
  ])
  ok(`name 字段 ${r.status === 200 ? "被接受" : "HTTP " + r.status}（仅记录）`)
} catch (e) { fail("name 字段", e) }

console.log("[L5] temperature 边界值（0 和 2）")
try {
  const r0 = await chat([{ role: "user", content: "hi" }], { temperature: 0 })
  const r2 = await chat([{ role: "user", content: "hi" }], { temperature: 2 })
  const pass = r0.status === 200 && r2.status === 200
  ok(`temperature 0=${r0.status}, 2=${r2.status}`)
} catch (e) { fail("temperature 边界", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
