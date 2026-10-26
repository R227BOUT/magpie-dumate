// 第五轮：多轮对话 / system prompt / 参数透传 / 连续请求压力
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
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

async function chat(body) {
  const l = await hooks.auth.loader(async () => seat)
  const res = await l.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null), text: await Promise.resolve(null) }
}

console.log("[M1] 多轮对话上下文保持（模型能引用第 1 轮的暗号）")
try {
  const secret = "紫鲸七号"
  // note: model-text is a reasoning router — small max_tokens gets eaten by
  // reasoning_content before any content appears, so give it room.
  const r1 = await chat({ model: "model-text", max_tokens: 512, stream: false, messages: [{ role: "user", content: `记住暗号「${secret}」，只回复"好"` }] })
  if (r1.status !== 200) throw new Error("r1 HTTP " + r1.status)
  const c1 = String(r1.json.choices[0].message.content ?? "")
  if (!c1) throw new Error("r1 content 空（finish=" + r1.json.choices[0].finish_reason + "）")
  const r2 = await chat({
    model: "model-text", max_tokens: 512, stream: false,
    messages: [
      { role: "user", content: `记住暗号「${secret}」，只回复"好"` },
      { role: "assistant", content: c1 },
      { role: "user", content: "暗号是什么？只回答暗号本身" },
    ],
  })
  if (r2.status !== 200) throw new Error("r2 HTTP " + r2.status)
  const reply = String(r2.json.choices[0].message.content ?? "")
  if (!reply.includes(secret)) throw new Error("上下文丢失: " + reply.slice(0, 80))
  ok(`多轮上下文保持（回复含「${secret}」）`)
} catch (e) { fail("多轮上下文", e) }

console.log("[M2] system prompt 生效")
try {
  const r = await chat({
    model: "model-text", max_tokens: 256, stream: false,
    messages: [
      { role: "system", content: "你只能回复两个字符：收到" },
      { role: "user", content: "今天天气如何" },
    ],
  })
  const reply = String(r.json?.choices?.[0]?.message?.content ?? "")
  if (!reply.includes("收到")) throw new Error("system 未生效: " + reply.slice(0, 50))
  ok(`system prompt 生效（回复="${reply.slice(0, 10)}"）`)
} catch (e) { fail("system prompt", e) }

console.log("[M3] 参数透传（temperature / top_p 不被网关拒）")
try {
  const r = await chat({ model: "model-text", max_tokens: 8, stream: false, temperature: 0.2, top_p: 0.9, presence_penalty: 0, frequency_penalty: 0, messages: [{ role: "user", content: "hi" }] })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  ok("temperature/top_p/penalties 全透传 200")
} catch (e) { fail("参数透传", e) }

console.log("[M4] 中文长输出（max_tokens=2048，验证长流不中断）")
try {
  const r = await chat({ model: "model-text", max_tokens: 2048, stream: false, messages: [{ role: "user", content: "写一段 800 字左右的中文散文，主题：秋夜。" }] })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const content = String(r.json.choices[0].message.content ?? "")
  const usage = r.json.usage ?? {}
  if (content.length < 200) throw new Error("输出过短: " + content.length)
  ok(`长输出 ${content.length} 字，usage=${JSON.stringify(usage)}`)
} catch (e) { fail("中文长输出", e) }

console.log("[M5] 连续 6 发快速请求（无间隔压力）")
try {
  const l = await hooks.auth.loader(async () => seat)
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      l.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: `第${i}个请求，回复ok` }] }) })
        .then((r) => r.status),
    ),
  )
  const bad = results.filter((s) => s !== 200)
  if (bad.length) throw new Error(`非200: ${bad.join(",")}`)
  ok("6/6 全部 200")
} catch (e) { fail("压力", e) }

console.log("[M6] usage JSON 完整性（magpie quota UI 依赖的字段）")
try {
  const u = await hooks.auth.usage(async () => seat)
  for (const f of ["plan", "balance", "windows", "user"]) {
    if (!(f in u)) throw new Error("缺字段 " + f)
  }
  const w = u.windows[0]
  for (const f of ["name", "used", "display", "limit"]) {
    if (!(f in w)) throw new Error("window 缺字段 " + f)
  }
  if (!(typeof w.used === "number" && w.used >= 0 && w.used <= 100)) throw new Error("used 不是 0-100 百分比: " + w.used)
  ok(`字段齐全: plan=${u.plan}, window display=${w.display}`)
} catch (e) { fail("usage 字段", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
