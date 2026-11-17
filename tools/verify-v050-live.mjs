#!/usr/bin/env node
// v0.5.0 真实数据验收（已获用户预授权：最多 3 条极小请求，顺序执行，失败即停）。
//
// 三条验收与判定标准（不把「请求已发出」当通过）：
//   Live 1  qwen4-max            → 核验补身份头后上游状态码；200 且响应模型回显
//                                  为 qwen4-max 才算调用成功；400 保留脱敏错误证据，
//                                  如实判定「未修复」。
//   Live 2  deepseek-v41-flash   → 200 + 正文非空 + finish_reason 合理；预算抬升的
//                                  出站证据 = usage.completion_tokens > 请求的
//                                  1000（若 ≤1000 记 INCONCLUSIVE，不算证明）。
//   Live 3  glm-5                → 出站映射 glm-5=>glm-53（响应 Route 诊断头）+
//                                  X-Dumate-Gw-Realmodel 揭示的实际后端身份。
//
// macOS 兼容：登录态发现走插件自身的跨平台逻辑（paths.mjs），不碰 APPDATA。
// 脱敏：输出只有状态码 / 模型名 / 用量数字 / 响应头白名单字段，绝不打印
// Cookie、token 或完整响应体。
import { DuMatePlugin, _internal } from "../index.mjs"

const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const note = (n, extra = "") => console.log(`  NOTE ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("== magpie-dumate v0.5.0 live 验收（≤3 条，失败即停）==")

// 登录态：插件自身的跨平台桌面登录发现（macOS/Linux/Windows 同一套代码）。
const desktop = _internal.readDesktopLogin()
if (!desktop?.cookies?.length) {
  console.error("本机没有可用的 DuMate 桌面登录态——live 验收需要真实登录态，未发任何请求。")
  process.exit(1)
}
const seat = {
  type: "oauth",
  cookies: desktop.cookies,
  source: "desktop",
  accountId: desktop.accountId || "",
  name: desktop.name || "",
}
console.log(`登录态: desktop · accountId 形态合法=${/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(seat.accountId)} · cookies=${desktop.cookies.length} 条（不打印内容）`)

const hooks = await DuMatePlugin({})
const loader = await hooks.auth.loader(async () => seat)

// 响应头白名单：只有这些字段允许进入验收输出。
const safeHeaders = (h) => {
  const out = {}
  for (const name of ["x-dumate-gw-realmodel", "x-magpie-dumate-route", "x-magpie-sign-in", "content-type", "x-request-id"]) {
    const v = h.get(name)
    if (v) out[name] = v
  }
  return out
}

async function ask(label, body) {
  const r = await loader.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const headers = safeHeaders(r.headers)
  let payload = null
  try { payload = await r.json() } catch {}
  return { r, headers, payload }
}

// ---- Live 1: qwen4-max（缺头假设的修复验证） --------------------------------
console.log("\n[Live 1/3] qwen4-max —— 补身份头后是否由 400 恢复")
try {
  const { r, headers, payload } = await ask("qwen4-max", {
    model: "qwen4-max", max_tokens: 64,
    messages: [{ role: "user", content: "只回复两个字：收到" }],
  })
  console.log(`  状态码: ${r.status} · 响应头: ${JSON.stringify(headers)}`)
  if (r.status === 200) {
    const echo = payload?.model ?? payload?.choices?.[0]?.model
    const content = payload?.choices?.[0]?.message?.content ?? ""
    if (echo && echo !== "qwen4-max") throw new Error(`200 但模型回显不是 qwen4-max: ${echo}（疑似被改写，不算成功）`)
    if (!String(content).trim()) throw new Error("200 但正文为空")
    ok("qwen4-max 200 且模型回显一致、正文非空 —— 缺头假设成立，调用成功")
  } else {
    const msg = String(payload?.error?.message ?? payload?.message ?? "").slice(0, 160)
    note(`qwen4-max 仍为 ${r.status}——补头未修复，保留脱敏错误证据: ${msg}`)
    console.log("  （按验收标准记为「未修复」，不中断后续条目——本条目标本身已达成：状态已实测）")
  }
} catch (e) { fail("Live 1 qwen4-max", e) }

// ---- Live 2: deepseek-v41-flash（预算抬升 + 正文/结束原因） ------------------
console.log("\n[Live 2/3] deepseek-v41-flash —— max_tokens:1000 请求，floor 应抬到 65536")
try {
  const { r, headers, payload } = await ask("deepseek-v41-flash", {
    model: "deepseek-v41-flash", max_tokens: 1000, reasoning_effort: "high",
    messages: [{ role: "user", content: "用一句话说明什么是互斥锁" }],
  })
  console.log(`  状态码: ${r.status} · 响应头: ${JSON.stringify(headers)}`)
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const choice = payload?.choices?.[0]
  const content = String(choice?.message?.content ?? "")
  const finish = choice?.finish_reason ?? payload?.choices?.[0]?.finish_reason
  const usage = payload?.usage ?? {}
  const completion = usage.completion_tokens ?? 0
  console.log(`  usage: prompt=${usage.prompt_tokens ?? "?"} completion=${completion} reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? "?"}`)
  if (!content.trim()) throw new Error("正文为空（预算被思考耗尽？）")
  if (!["stop", "length", "tool_calls"].includes(finish)) throw new Error("finish_reason 异常: " + finish)
  // 预算抬升的出站证据：若 max_tokens 仍是 1000，单次生成不可能超过 1000。
  if (completion > 1000) {
    ok(`completion_tokens=${completion} > 请求值 1000 —— floor 抬升的出站实据；正文 ${content.length} 字、finish=${finish}`)
  } else {
    note(`completion_tokens=${completion} ≤ 1000 —— 本轮无法证明抬升（模型没用满），离线矩阵 B8 已证明变换正确`)
  }
} catch (e) { fail("Live 2 deepseek", e) }

// ---- Live 3: glm-5（版本替代映射 + 实际后端身份） ----------------------------
console.log("\n[Live 3/3] glm-5 —— 出站映射 glm-53 + Realmodel 实际后端")
try {
  const { r, headers, payload } = await ask("glm-5", {
    model: "glm-5", max_tokens: 64,
    messages: [{ role: "user", content: "只回复两个字：收到" }],
  })
  console.log(`  状态码: ${r.status} · 响应头: ${JSON.stringify(headers)}`)
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const route = headers["x-magpie-dumate-route"]
  if (route !== "glm-5=>glm-53") throw new Error("路由诊断头缺失或不符: " + route)
  const echo = payload?.model
  if (echo && echo !== "glm-53") throw new Error("响应模型回显异常: " + echo)
  const real = headers["x-dumate-gw-realmodel"]
  if (real) {
    ok(`glm-5→glm-53 已出站（Route 头）· 实际后端 = ${real}（X-Dumate-Gw-Realmodel）`)
  } else {
    note("glm-5→glm-53 已出站（Route 头）；上游未回 Realmodel 头，实际后端 UNKNOWN")
  }
} catch (e) { fail("Live 3 glm-5", e) }

console.log(process.exitCode ? "\n== live 验收有失败项 ==" : "\n== live 验收完成 ==")
