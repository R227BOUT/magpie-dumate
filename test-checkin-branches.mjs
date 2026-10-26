// 第七轮：checkin 五分支全覆盖（fetch mock，不联网不耗积分）
// 真实分支（已签=done）已在前几轮验证；这里把 mock 能逼出来的分支全走一遍。
import { DuMatePlugin } from "./index.mjs"

const seat = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "x", domain: ".baidu.com" }], source: "manual" }
const getAuth = async () => seat
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

// tiny fetch mock: routes by URL substring, in order
function withFetch(routes, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init)
    }
    throw new Error("no mock route for " + url)
  }
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real })
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })

const hooks = await DuMatePlugin({})

console.log("[K1] 未签 → POST → hasIssued=true → claimed + delta 积分")
try {
  let posted = false
  const r = await withFetch([
    ["loginBonusInfo", () => json({ code: 0, success: true, result: { hasIssued: false, totalPoints: "1000", totalTimes: 5 } })],
    ["loginBonus", () => { posted = true; return json({ code: 0, success: true, result: true }) }],
  ], async () => {
    // 第二次 loginBonusInfo（after）在 POST 后返回 hasIssued=true + 1050
    let call = 0
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url
      if (url.includes("loginBonusInfo")) {
        call++
        return call === 1
          ? json({ code: 0, result: { hasIssued: false, totalPoints: "1000", totalTimes: 5 } })
          : json({ code: 0, result: { hasIssued: true, totalPoints: "1050", totalTimes: 6 } })
      }
      if (url.includes("loginBonus")) { posted = true; return json({ code: 0, result: true }) }
      throw new Error("no route " + url)
    }
    return hooks.auth.checkin(getAuth)
  })
  if (!posted) throw new Error("loginBonus POST 未发出")
  if (r.outcome !== "claimed") throw new Error("outcome=" + r.outcome)
  if (r.credit !== 50) throw new Error("credit=" + r.credit + "（应 50，不是硬编码 500）")
  if (!/签/.test(r.message ?? "")) throw new Error("message 缺少签到提示")
  ok(`claimed + credit=50（delta 计算正确，非硬编码）`)
} catch (e) { fail("未签领取分支", e) }

console.log("[K2] 未签 → POST → after 仍无到账 → inactive（不谎报 claimed）")
try {
  const r = await withFetch([["x", () => {}]], async () => {
    let call = 0
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url
      if (url.includes("loginBonusInfo")) {
        call++
        return json({ code: 0, result: { hasIssued: call === 1 ? false : false, totalPoints: "1000" } })
      }
      if (url.includes("loginBonus")) return json({ code: 0, result: true })
      throw new Error("no route")
    }
    return hooks.auth.checkin(getAuth)
  })
  // POST 发出去了但积分没到账：claimed 是站不住的（我们无法证明领到了）。
  // inactive 才是诚实答案，宿主当天稍后会再问一次。
  if (r.outcome !== "inactive") throw new Error("outcome=" + r.outcome + "（应为 inactive）")
  if (r.credit !== undefined) throw new Error("不应给 credit: " + r.credit)
  if (!/未到账|稍后/.test(r.message ?? "")) throw new Error("message 应说明未到账并会重试: " + r.message)
  ok("inactive 无 credit（不谎报领取）")
} catch (e) { fail("异步落账分支", e) }

console.log("[K3] POST 抛错 → failed + 原始信息")
try {
  const r = await withFetch([["x", () => {}]], async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url
      if (url.includes("loginBonusInfo")) return json({ code: 0, result: { hasIssued: false, totalPoints: "1" } })
      if (url.includes("loginBonus")) return json({ code: 500, success: false, message: "积分服务繁忙" }, 200)
      throw new Error("no route")
    }
    return hooks.auth.checkin(getAuth)
  })
  if (r.outcome !== "failed") throw new Error("outcome=" + r.outcome)
  if (!/积分服务繁忙|接口错误/.test(r.message ?? "")) throw new Error("message 丢了原因: " + r.message)
  ok(`failed + 原因透传（${String(r.message).slice(0, 30)}…）`)
} catch (e) { fail("POST 失败分支", e) }

console.log("[K4] loginBonusInfo 抛错 + POST 成功 + after 抛错 → inactive（信息不足时不谎报）")
try {
  const r = await withFetch([["x", () => {}]], async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url
      if (url.includes("loginBonusInfo")) throw new Error("info 接口挂了")
      if (url.includes("loginBonus")) return json({ code: 0, result: true })
      throw new Error("no route")
    }
    return hooks.auth.checkin(getAuth)
  })
  // 前提接口挂了 → 既不知道是否已签、也不知道到账没 → 只能说 inactive
  if (r.outcome !== "inactive") throw new Error("outcome=" + r.outcome + "（应为 inactive）")
  if (!/未到账|稍后/.test(r.message ?? "")) throw new Error("message: " + r.message)
  ok("inactive + 兜底提示（不在证据不足时称领取成功）")
} catch (e) { fail("info 失败兜底", e) }

console.log("[K5] usage 各失败形态的降级（mock）")
try {
  const u1 = await withFetch([["x", () => {}]], async () => {
    globalThis.fetch = async () => json({ code: 0, result: { totalPoints: "123.45", checkInDays: 3, displayName: "甲" } })
    return hooks.auth.usage(getAuth)
  })
  if (u1.error || u1.balance !== "123.45 积分") throw new Error("正常形态: " + JSON.stringify(u1).slice(0, 120))
  const u2 = await withFetch([["x", () => {}]], async () => {
    globalThis.fetch = async () => { throw new Error("network down") }
    return hooks.auth.usage(getAuth)
  })
  if (!u2.error || u2.signIn !== "kept") throw new Error("网络挂形态: " + JSON.stringify(u2).slice(0, 120))
  ok("usage 正常/网络挂两种形态都对")
} catch (e) { fail("usage 形态", e) }

console.log("[K6] 登录失效时 checkin/usage 必须带 signIn=expired（否则 magpie 不会提示重登）")
try {
  // 百度对过期会话返回 200 + HTML 登录页；consoleGet 会把它映射成 signIn=expired。
  // 这条错误必须一路传到 hook 的返回值里，magpie 才会标记账号并停止重试。
  const html = () => new Response("<!DOCTYPE html><html><body>请登录</body></html>", { status: 200, headers: { "Content-Type": "text/html" } })
  const c = await withFetch([["x", () => {}]], async () => {
    globalThis.fetch = async () => html()
    return hooks.auth.checkin(getAuth)
  })
  if (c.outcome !== "failed") throw new Error("checkin outcome=" + c.outcome)
  if (c.signIn !== "expired") throw new Error("checkin 缺 signIn=expired: " + JSON.stringify(c))
  const u = await withFetch([["x", () => {}]], async () => {
    globalThis.fetch = async () => html()
    return hooks.auth.usage(getAuth)
  })
  if (u.signIn !== "expired") throw new Error("usage 缺 signIn=expired: " + JSON.stringify(u).slice(0, 120))
  ok("checkin + usage 都正确上报 signIn=expired")
} catch (e) { fail("登录失效传播", e) }

console.log("[K7] 消息里的控制字符必须被消毒（防伪造日志行/终端转义）")
try {
  const evil = "错误\nFAKE LOG LINE\u001b[31m red\u202Eevil"
  const c = await withFetch([["x", () => {}]], async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url
      if (url.includes("loginBonusInfo")) return json({ code: 0, result: { hasIssued: false, totalPoints: "1" } })
      if (url.includes("loginBonus")) return json({ code: 500, success: false, message: evil }, 200)
      throw new Error("no route")
    }
    return hooks.auth.checkin(getAuth)
  })
  const msg = String(c.message ?? "")
  if (/[\n\r\u001b\u202E]/.test(msg)) throw new Error("消息里仍有控制字符: " + JSON.stringify(msg))
  ok("控制字符已消毒（换行/ESC/bidi 都清掉）")
} catch (e) { fail("消息消毒", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
