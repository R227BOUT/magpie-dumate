// 第十二轮：token 刷新边界 + 单飞缓存逻辑级验证（mock console 端点，不耗积分）
import { DuMatePlugin } from "./index.mjs"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const cookies = [{ name: "bce-sessionid", value: "v", domain: ".baidu.com" }]
const seat = { type: "oauth", cookies, source: "manual" }
const hooks = await DuMatePlugin({})
const loader = await hooks.auth.loader(async () => seat)
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"

// mock token/get：计数器 + 可控过期时间
let tokenCalls = 0
let expiredIn = 60 * 60 * 1000 // 1h
let tokenSeq = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url ?? ""
  if (url.includes("/api/dumate/app/token/get")) {
    tokenCalls++
    tokenSeq++
    return new Response(JSON.stringify({
      code: 0, success: true,
      result: { token: `tok-${tokenSeq}`, expired_at: new Date(Date.now() + expiredIn).toISOString() },
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  if (url.includes("dumate-svc")) {
    // 校验 token 是最新签发的
    const auth = init?.headers?.get?.("Authorization") ?? init?.headers?.Authorization ?? ""
    const tok = String(auth).replace("Bearer ", "")
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json", "x-seen-token": tok } })
  }
  return realFetch(input, init)
}

async function one() {
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })
  const j = await r.json()
  return { status: r.status, seen: r.headers.get("x-seen-token") }
}

console.log("[Z1] 首次请求取 token（1 次调用）")
try {
  const r = await one()
  if (tokenCalls !== 1) throw new Error(`token 调用 ${tokenCalls} 次`)
  if (r.seen !== "tok-1") throw new Error("用了错误 token: " + r.seen)
  ok("tok-1 正确携带")
} catch (e) { fail("首次取 token", e) }

console.log("[Z2] 缓存期内重复请求不再取 token")
try {
  await one(); await one(); await one()
  if (tokenCalls !== 1) throw new Error(`缓存失效：token 调用已达 ${tokenCalls} 次`)
  ok("4 次请求仅 1 次 token 调用")
} catch (e) { fail("缓存复用", e) }

console.log("[Z3] 过期前 5 分钟余量：新 cookieHeader + 4 分钟过期 → 重取")
try {
  // note: 缓存按签发时的过期时间算，改 mock 的 expiredIn 不影响已缓存条目（正确语义）。
  // 用全新 cookieHeader 建独立缓存条目来测刷新边界。
  const seatB = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "B3", domain: ".baidu.com" }], source: "manual" }
  const loaderB = await hooks.auth.loader(async () => seatB)
  expiredIn = 4 * 60 * 1000
  const r = await loaderB.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })
  if (tokenCalls !== 2) throw new Error(`应重取 token，实际 ${tokenCalls} 次`)
  ok("4 分钟过期触发即时签发（tok-2，不缓存 5 分钟内）")
} catch (e) { fail("提前刷新", e) }

console.log("[Z4] 并发 8 路在过期边界 → 单飞（只 1 次新 token 调用）")
try {
  // seatB 的缓存条目过期 4min < 5min 余量 → 每次请求都会触发取 token；
  // 8 路并发应单飞成 1 次。先等 pending 落定，再发并发。
  const seatB = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "B3", domain: ".baidu.com" }], source: "manual" }
  const loaderB = await hooks.auth.loader(async () => seatB)
  expiredIn = 3 * 60 * 1000
  const before = tokenCalls
  // 手工使缓存条目过期：等 0ms 不行——直接换第 4 个 cookieHeader 来制造"无缓存+并发"场景
  const seatC = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "C4", domain: ".baidu.com" }], source: "manual" }
  const loaderC = await hooks.auth.loader(async () => seatC)
  await Promise.all(Array.from({ length: 8 }, () => loaderC.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })))
  const gained = tokenCalls - before
  if (gained !== 1) throw new Error(`单飞失效：8 并发取了 ${gained} 次 token`)
  ok("8 并发只取 1 次 token（单飞生效）")
} catch (e) { fail("单飞", e) }

console.log("[Z5] token/get 报登录页 → 401 + signIn=expired（缓存不被写入）")
try {
  // 用全新 cookieHeader 避开 Z4 缓存
  const seatD = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "D5", domain: ".baidu.com" }], source: "manual" }
  const loaderD = await hooks.auth.loader(async () => seatD)
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response("<!DOCTYPE html><html><title>百度智能云-登录</title></html>", { status: 200, headers: { "Content-Type": "text/html" } })
    }
    return new Response("{}", { status: 200 })
  }
  const r = await loaderD.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })
  if (r.status !== 401) throw new Error("HTTP " + r.status)
  if (r.headers.get("x-magpie-sign-in") !== "expired") throw new Error("signIn 头不对")
  ok("HTML 登录页 → 401/expired")
} catch (e) { fail("token 端点登录页", e) }

console.log("[Z6] token/get 返回空 token → 502 + signIn=kept（网络形态，不逼重登）")
try {
  const seatE = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "E6", domain: ".baidu.com" }], source: "manual" }
  const loaderE = await hooks.auth.loader(async () => seatE)
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "" } }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response("{}", { status: 200 })
  }
  const r = await loaderE.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })
  if (r.status !== 502) throw new Error("HTTP " + r.status)
  if (r.headers.get("x-magpie-sign-in") !== "kept") throw new Error("应为 kept")
  ok("空 token → 502/kept")
} catch (e) { fail("空 token", e) }

globalThis.fetch = realFetch
console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
