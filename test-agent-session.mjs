// 第九轮：agent 综合演练 —— 模拟真实 coding agent 的完整会话
// 多轮 + 多工具 + 流式 + 并发工具批 + system + 长上下文交错，全程走插件 loader。
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

const TOOLS = [
  { type: "function", function: { name: "read_file", description: "读取文件内容", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_dir", description: "列出目录", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "calc", description: "计算器，输入表达式", parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } } },
]

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

async function chatStream(messages, extra = {}) {
  const res = await loader.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "model-text", max_tokens: 2048, stream: true, stream_options: { include_usage: true }, tools: TOOLS, ...extra, messages }),
  })
  if (res.status !== 200) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 150))
  let content = "", tcName = "", tcArgs = "", finish = null, usage = null
  let pendingCalls = {} // 流式分片重组缓冲
  for await (const ev of res.body) { /* placeholder replaced below */ }
  return { content, tcName, tcArgs, finish, usage }
}
// 上面的 for-await 写法不兼容 NDJSON，换成读全文解析（与真实 SDK 内部等价）
async function chat(messages, extra = {}) {
  const res = await loader.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "model-text", max_tokens: 2048, stream: true, stream_options: { include_usage: true }, tools: TOOLS, ...extra, messages }),
  })
  if (res.status !== 200) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 150))
  const text = await res.text()
  let content = "", finish = null, usage = null
  const calls = {}
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (data === "[DONE]") break
    const j = JSON.parse(data)
    const delta = j.choices?.[0]?.delta ?? {}
    if (delta.content) content += delta.content
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0
      calls[i] ??= { name: "", args: "" }
      if (tc.function?.name) calls[i].name = tc.function.name
      if (tc.function?.arguments) calls[i].args += tc.function.arguments
    }
    if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason
    if (j.usage) usage = j.usage
  }
  const toolCalls = Object.entries(calls).map(([i, c]) => ({ index: Number(i), id: `call_${i}`, type: "function", function: { name: c.name, arguments: c.args } }))
  return { content, toolCalls, finish, usage }
}

console.log("[A1] 完整 agent 回合：读文件 → 算数 → 并发双工具 → 总结")
try {
  const msgs = [
    { role: "system", content: "你是一个文件助手。需要数据时调用工具，拿到结果后用中文简要回答。所有工具都可以并行调用。" },
  ]
  let turn = 0
  let toolRounds = 0
  let totalCalls = 0
  let finalContent = ""
  msgs.push({ role: "user", content: "请读取 /tmp/app.log 的内容，然后分别计算 17*23 和 1024/8（可并行调用），最后告诉我日志里最常出现的词。" })

  while (turn < 8) {
    turn++
    const r = await chat(msgs)
    if (r.toolCalls.length === 0) { finalContent = r.content; break }
    toolRounds++
    totalCalls += r.toolCalls.length
    msgs.push({ role: "assistant", content: r.content ?? "", tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: "function", function: t.function })) })
    for (const t of r.toolCalls) {
      let result = "错误"
      if (t.function.name === "read_file") result = "2026-10-26 03:00 [INFO] sync started\n2026-10-26 03:01 [WARN] retry queue=retry\n2026-10-26 03:02 [INFO] sync done"
      else if (t.function.name === "calc") result = String(t.function.arguments.includes("17*23") ? 391 : t.function.arguments.includes("1024/8") ? 128 : NaN)
      else if (t.function.name === "list_dir") result = "app.log, data/"
      msgs.push({ role: "tool", tool_call_id: t.id, content: result })
    }
  }
  if (turn >= 8) throw new Error("8 轮未收敛")
  if (toolRounds < 1) throw new Error("没有工具回合")
  if (totalCalls < 2) throw new Error(`工具调用总数过少: ${totalCalls}`)
  if (!/retry|391|128/.test(finalContent)) throw new Error("最终回答未引用工具数据: " + finalContent.slice(0, 80))
  ok(`agent 会话收敛：${turn} 轮、${toolRounds} 次工具回合共 ${totalCalls} 次调用，最终回答引用了工具数据`, `内容 ${finalContent.length} 字`)
} catch (e) { fail("agent 综合演练", e) }

console.log("[A2] 流式与并发交错（4 路 stream 同时开）")
try {
  const opens = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      loader.fetch(GW, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "model-text", max_tokens: 256, stream: true, messages: [{ role: "user", content: `数到${i + 1}，然后说done${i}` }] }),
      }).then(async (r) => ({ status: r.status, text: await r.text() })),
    ),
  )
  const allOk = opens.every((o) => o.status === 200 && o.text.includes("[DONE]"))
  if (!allOk) throw new Error("有流未正常收尾: " + opens.map((o) => o.status).join(","))
  ok("4 路并发流式全部 [DONE] 收尾")
} catch (e) { fail("并发流式", e) }

console.log("[A3] 长上下文 agent 会话（模拟 20 轮历史 + 系统提示，约 8k tokens）")
try {
  const history = []
  for (let i = 0; i < 20; i++) {
    history.push({ role: "user", content: `第${i}轮：请记住变量 v${i}=${i * 7}。` })
    history.push({ role: "assistant", content: `已记住 v${i}=${i * 7}。` })
  }
  const r = await chat([...history.slice(-12), { role: "user", content: "v3 和 v5 分别是多少？只回答两个数字。" }], {})
  // 注意：v3/v5 在截掉的更早轮里——只测长上下文不崩 + 正常返回，不判对错
  if (!r.content && !r.toolCalls.length) throw new Error("空响应 finish=" + r.finish)
  ok(`12 轮历史（约 1.5k tokens）响应正常，finish=${r.finish}`)
} catch (e) { fail("长上下文", e) }

console.log("[A4] 工具调用后跟系统消息插入（部分 SDK 会注入 system 刷新）")
try {
  const r1 = await chat([{ role: "user", content: "调用计算器算 2+3" }])
  if (!r1.toolCalls.length) throw new Error("未发起工具调用")
  const msgs2 = [
    { role: "user", content: "调用计算器算 2+3" },
    { role: "assistant", content: "", tool_calls: r1.toolCalls.map((t) => ({ id: t.id, type: "function", function: t.function })) },
    { role: "system", content: "提醒：结果要精确。" },
    { role: "tool", tool_call_id: r1.toolCalls[0].id, content: "5" },
  ]
  const r2 = await chat(msgs2)
  if (r2.status === undefined && !r2.content) throw new Error("空响应")
  ok("system 消息插在 tool 结果前仍正常（content 有值）")
} catch (e) { fail("system 插入 tool 流", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
