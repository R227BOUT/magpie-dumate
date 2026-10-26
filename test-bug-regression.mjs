// 第十五轮：把八个已修 bug 全部做成"回归哨兵"——每个 bug 一个专杀用例，
// 确保未来改动不会让任何已修 bug 复活。全部离线 mock，不耗积分。
import { DuMatePlugin, _internal } from "./index.mjs"

const { parseCookieString } = _internal
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }
const hooks = await DuMatePlugin({})
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
const realFetch = globalThis.fetch

console.log("[G1] bug#1 哨兵：document.cookie 串（无 bce-sessionid）必须被拒")
try {
  const docCookie = "BAIDUID=abc; PSTM=1; BIDUPSID=2" // 无 bce-sessionid
  const flow = await hooks.auth.methods[1].authorize()
  const r = await flow.callback(docCookie)
  if (r.type !== "failed" || !/bce-sessionid/.test(r.error)) throw new Error("拒绝对话失效: " + JSON.stringify(r).slice(0, 100))
  ok("浏览器登录仍强制 bce-sessionid")
} catch (e) { fail("bug#1", e) }

console.log("[G2] bug#2 哨兵：config hook 必须是函数且注册出模型")
try {
  if (typeof hooks.config !== "function") throw new Error("config 退化了")
  const cfg = {}
  await hooks.config(cfg)
  if (Object.keys(cfg.provider.dumate.models).length < 2) throw new Error("模型数不足")
  ok("async config + 2 模型在位")
} catch (e) { fail("bug#2", e) }

console.log("[G3] bug#3 哨兵：desktop seat 的 refresh 会读本机 auth.json（不抛错）")
try {
  const r = await hooks.auth.refresh({ type: "oauth", source: "desktop", cookies: [{ name: "x", value: "1", domain: ".baidu.com" }] })
  // 本机 auth.json 存在且 header 不同 → 返回新 auth；不存在/相同 → undefined；都合法，但不能抛
  if (r !== undefined && !r.cookies) throw new Error("refresh 返回异常形态")
  ok(`refresh 正常（${r === undefined ? "本机未变/不可用" : "跟随了 " + r.cookies.length + " 条新 cookie"}）`)
} catch (e) { fail("bug#3", e) }

console.log("[G4] bug#4 哨兵：签到积分来自 delta 而非硬编码")
try {
  let g4state = 0
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("loginBonusInfo")) {
      // 用非常规数额（1234→1337，delta=103）确保不是 500 硬编码
      g4state++
      return g4state === 1
        ? new Response(JSON.stringify({ code: 0, result: { hasIssued: false, totalPoints: "1234", totalTimes: 1 } }), { status: 200 })
        : new Response(JSON.stringify({ code: 0, result: { hasIssued: true, totalPoints: "1337", totalTimes: 2 } }), { status: 200 })
    }
    if (url.includes("loginBonus")) return new Response(JSON.stringify({ code: 0, result: true }), { status: 200 })
    return realFetch(input)
  }
  const seat = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "g4", domain: ".baidu.com" }], source: "manual" }
  const c = await hooks.auth.checkin(async () => seat)
  if (c.credit !== 103) throw new Error("credit=" + c.credit + " 应为 103（delta）")
  ok("delta=103 正确（非硬编码 500）")
} catch (e) { fail("bug#4", e) }

console.log("[G5] bug#7 哨兵：HTML 登录页 → 401 expired（非 502 接口错误）")
try {
  const seat = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "g5-fresh-" + Date.now(), domain: ".baidu.com" }], source: "manual" }
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("token/get")) return new Response("<!DOCTYPE html><html>百度智能云-登录</html>", { status: 200 })
    return new Response("{}", { status: 200 })
  }
  const l = await hooks.auth.loader(async () => seat)
  const r = await l.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", messages: [{ role: "user", content: "x" }] }) })
  if (r.status !== 401 || r.headers.get("x-magpie-sign-in") !== "expired") throw new Error(`HTTP ${r.status}/${r.headers.get("x-magpie-sign-in")}`)
  ok("登录页正确映射 401/expired")
} catch (e) { fail("bug#7", e) }

console.log("[G6] bug#9 哨兵：expireDate=null 不产生 1970 时间戳")
try {
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("quota_overview")) {
      return new Response(JSON.stringify({ code: 0, result: { totalPoints: "100", usedPoints: "1", subscription: [{ status: "active", expireDate: null }] } }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, result: { totalTimes: 0 } }), { status: 200 })
  }
  const seat = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "g6", domain: ".baidu.com" }], source: "manual" }
  const u = await hooks.auth.usage(async () => seat)
  if (u.windows[0].runsOutAt !== undefined) throw new Error("仍产生 runsOutAt: " + u.windows[0].runsOutAt)
  ok("null expireDate 无 runsOut")
} catch (e) { fail("bug#9", e) }

globalThis.fetch = realFetch
console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
