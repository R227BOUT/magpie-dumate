#!/usr/bin/env node
// v0.5.0 真实数据验收（预授权：最多 3 条极小请求，**真失败即停**）。
//
// 三类判定，FAIL 即停止、后续条目标记 NOT EXECUTED：
//   PASS         —— 该条目的成功判据全部成立
//   INCONCLUSIVE —— 请求成功但证据不足以证明目标行为（继续下一条）
//   FAIL         —— 请求失败或成功判据被推翻（立即停止）
//
// 三条验收与判定标准（不把「请求已发出」当通过）：
//   Live 1  qwen4-max            → 200 且模型回显为 qwen4-max 才 PASS；
//                                  其余状态码一律 FAIL（修复未成立即停）。
//   Live 2  deepseek-v41-flash   → 200 + 正文非空 + finish_reason 合理；
//                                  budget 抬升证据 = completion_tokens > 1000
//                                  （>1000 记 PASS 证据位；≤1000 记 INCONCLUSIVE）。
//   Live 3  glm-5                → Route 诊断头 glm-5=>glm-53 + X-Dumate-Gw-Realmodel；
//                                  Route 头不符 → FAIL；仅缺 Realmodel → INCONCLUSIVE。
//
// 历史：2026-11-17 首轮执行中 Live 1 返回 400 后未停止、继续跑了 Live 2/3——
// 该偏差已如实登记在 VERIFY-050.md；本版本脚本修正为真失败即停，
// **只修脚本不重新执行**（既有 3 条授权已用完）。
//
// macOS 兼容：登录态发现走插件自身的跨平台逻辑（paths.mjs），不碰 APPDATA。
// 脱敏：输出只有状态码 / 模型名 / 用量数字 / 响应头白名单字段，绝不打印
// Cookie、token 或完整响应体。
import { DuMatePlugin, _internal } from "../index.mjs"

const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const note = (n, extra = "") => console.log(`  NOTE ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("== magpie-dumate v0.5.0 live 验收（≤3 条，FAIL 即停）==")

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

const safeHeaders = (h) => {
  const out = {}
  for (const name of ["x-dumate-gw-realmodel", "x-magpie-dumate-route", "x-magpie-sign-in", "content-type", "x-request-id"]) {
    const v = h.get(name)
    if (v) out[name] = v
  }
  return out
}

async function ask(body) {
  const r = await loader.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const headers = safeHeaders(r.headers)
  let payload = null
  try { payload = await r.json() } catch {}
  return { status: r.status, headers, payload }
}

// ---- Live 1: qwen4-max -------------------------------------------------------
console.log("\n[Live 1/3] qwen4-max —— 200 且模型回显一致才 PASS；其余状态 FAIL 即停")
let verdict1 = "FAIL"
try {
  const { status, headers, payload } = await ask({
    model: "qwen4-max", max_tokens: 64,
    messages: [{ role: "user", content: "只回复两个字：收到" }],
  })
  console.log(`  状态码: ${status} · 响应头: ${JSON.stringify(headers)}`)
  if (status === 200) {
    const echo = payload?.model ?? payload?.choices?.[0]?.model
    const content = String(payload?.choices?.[0]?.message?.content ?? "")
    if (echo && echo !== "qwen4-max") throw new Error(`200 但模型回显不是 qwen4-max: ${echo}（疑似被改写）`)
    if (!content.trim()) throw new Error("200 但正文为空")
    verdict1 = "PASS"
    ok("qwen4-max 200 且回显一致、正文非空")
  } else {
    const msg = String(payload?.error?.message ?? payload?.message ?? "").slice(0, 160)
    throw new Error(`HTTP ${status} —— 补头未修复，脱敏错误证据: ${msg}`)
  }
} catch (e) {
  fail("Live 1 qwen4-max", e)
}
if (verdict1 === "FAIL") {
  console.log("\n  [NOT EXECUTED] Live 2/3 —— 按 FAIL 即停约定不再发送（历史首轮偏差不再重复）")
  console.log(process.exitCode ? "\n== live 验收中止（有 FAIL） ==" : "\n== live 验收完成 ==")
  process.exit(process.exitCode || 1)
}

// ---- Live 2: deepseek-v41-flash ----------------------------------------------
console.log("\n[Live 2/3] deepseek-v41-flash —— 200+正文；completion>1000 才算抬升实据，否则 INCONCLUSIVE")
let verdict2 = "INCONCLUSIVE"
try {
  const { status, headers, payload } = await ask({
    model: "deepseek-v41-flash", max_tokens: 1000, reasoning_effort: "high",
    messages: [{ role: "user", content: "用一句话说明什么是互斥锁" }],
  })
  console.log(`  状态码: ${status} · 响应头: ${JSON.stringify(headers)}`)
  if (status !== 200) throw new Error("HTTP " + status)
  const choice = payload?.choices?.[0]
  const content = String(choice?.message?.content ?? "")
  const finish = choice?.finish_reason
  const usage = payload?.usage ?? {}
  const completion = usage.completion_tokens ?? 0
  console.log(`  usage: prompt=${usage.prompt_tokens ?? "?"} completion=${completion} reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? "?"}`)
  if (!content.trim()) throw new Error("正文为空（预算被思考耗尽？）")
  if (!["stop", "length", "tool_calls"].includes(finish)) throw new Error("finish_reason 异常: " + finish)
  if (completion > 1000) {
    verdict2 = "PASS"
    ok(`completion_tokens=${completion} > 请求值 1000 —— floor 抬升出站实据；finish=${finish}`)
  } else {
    verdict2 = "INCONCLUSIVE"
    note(`completion_tokens=${completion} ≤ 1000 —— 本轮无法证明抬升（模型没用满），记 INCONCLUSIVE`)
  }
} catch (e) {
  verdict2 = "FAIL"
  fail("Live 2 deepseek", e)
}
if (verdict2 === "FAIL") {
  console.log("\n  [NOT EXECUTED] Live 3 —— 按 FAIL 即停约定不再发送")
  console.log(process.exitCode ? "\n== live 验收中止（有 FAIL） ==" : "\n== live 验收完成 ==")
  process.exit(process.exitCode || 1)
}

// ---- Live 3: glm-5 -----------------------------------------------------------
console.log("\n[Live 3/3] glm-5 —— Route 诊断头 + Realmodel 实际后端")
try {
  const { status, headers, payload } = await ask({
    model: "glm-5", max_tokens: 64,
    messages: [{ role: "user", content: "只回复两个字：收到" }],
  })
  console.log(`  状态码: ${status} · 响应头: ${JSON.stringify(headers)}`)
  if (status !== 200) throw new Error("HTTP " + status)
  const route = headers["x-magpie-dumate-route"]
  if (route !== "glm-5=>glm-53") throw new Error("路由诊断头缺失或不符: " + route)
  const echo = payload?.model
  if (echo && echo !== "glm-53") throw new Error("响应模型回显异常: " + echo)
  const real = headers["x-dumate-gw-realmodel"]
  if (real) {
    verdict2 = "PASS"
    ok(`glm-5→glm-53 已出站（Route 头）· 实际后端 = ${real}（X-Dumate-Gw-Realmodel）`)
  } else {
    note("glm-5→glm-53 已出站（Route 头）；上游未回 Realmodel 头，实际后端 UNKNOWN → INCONCLUSIVE")
  }
} catch (e) {
  fail("Live 3 glm-5", e)
}

console.log(process.exitCode ? "\n== live 验收有失败项 ==" : "\n== live 验收完成 ==")
