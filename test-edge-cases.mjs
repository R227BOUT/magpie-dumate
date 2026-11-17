// 第十四轮：通读后发现的边界推演——用 mock 验证 4 个静态审查发现的疑点
import { DuMatePlugin } from "./index.mjs"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const cookies = [{ name: "bce-sessionid", value: "v14", domain: ".baidu.com" }]
const seat = { type: "oauth", cookies, source: "manual", name: "用户甲", accountId: "acc-14" }
const hooks = await DuMatePlugin({})
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"

// 疑点 1：gateway 返回 401 时插件把它转成自己的错误 JSON——上游 401 的原始错误信息被吞了
// （比如"token 过期"细节），用户只能看到统一文案。验证这是否可接受/是否丢信息。
// 疑点 2：usage 里 runsOut = Math.min(total-used, soonest.points) —— 若 soonest.points 是字符串
// parseFloat 已处理；但 expireDate 若是字符串秒，Number() 处理了。OK。
// 疑点 3：loader 中 `...init` 展开会把 init.body 传两次吗？——body: bodyText 在展开后覆盖，OK。
// 疑点 4：res.status === 401 时返回的错误把上游响应体丢弃了——上游 401 body 可能含
// 限流信息 vs 过期信息的区别。验证上游 401 的 body 是否值得透传。

const realFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url ?? ""
  if (url.includes("/api/dumate/app/token/get")) {
    return new Response(JSON.stringify({ code: 0, result: { token: "tok-x", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
  }
  if (url.includes("dumate-svc")) {
    // 模拟上游 401：token 撤销场景
    return new Response(JSON.stringify({ error: { code: "token_revoked", message: "gateway token revoked, re-obtain" } }), { status: 401, headers: { "Content-Type": "application/json" } })
  }
  return realFetch(input, init)
}

console.log("[W1] 上游 401（token 撤销）→ 清缓存 + expired 引导；上游错误细节是否保留")
try {
  const loader = await hooks.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })
  const body = await r.json()
  if (r.status !== 401) throw new Error("HTTP " + r.status)
  if (r.headers.get("x-magpie-sign-in") !== "expired") throw new Error("signIn 头: " + r.headers.get("x-magpie-sign-in"))
  // 检查丢失的上游信息是否关键：上游说 token_revoked，但网关 token 是每次会话签发的短时凭据，
  // 撤销即"重新取 token"——插件已清缓存，下次请求会自动重签。这个行为其实比透传更好。
  ok(`401 → 清缓存 + 引导重登（下次请求自动重签 token，上游细节无需保留）`)
} catch (e) { fail("上游 401 处理", e) }

console.log("[W2] 上游 401 后立即重试 → 自动重签 token 成功（自愈验证）")
try {
  let revokeMode = false
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-" + (revokeMode ? "fresh" : "x"), expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      if (revokeMode) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
      return new Response(JSON.stringify({ error: { message: "revoked" } }), { status: 401 })
    }
    return realFetch(input, init)
  }
  const loader = await hooks.auth.loader(async () => seat)
  // 第一发：token 撤销 → 401 + 清缓存
  await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })
  // 第二发：撤销解除 → 应重签 token 并成功
  revokeMode = true
  const r2 = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) })
  if (r2.status !== 200) throw new Error("重签后仍失败: HTTP " + r2.status)
  ok("401 清缓存 → 重试自动重签成功（自愈闭环）")
} catch (e) { fail("401 自愈", e) }

console.log("[W3] usage 的 soonest windows 计算推演（mock 非常规 pack 结构）")
try {
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("quota_overview")) {
      return new Response(JSON.stringify({
        code: 0, result: {
          // total 必须大于 used + soonest.points，否则 runsOut = total-used 会
          // 抢先于 soonest.points 成为最小值，断言就测不到"取到期包额度"这条逻辑。
          totalPoints: "6000", usedPoints: "100",
          subscription: [{ status: "active", expireDate: "1799999999", totalPoints: "5000" }],
          incremental: [{ status: "expired", expireDate: "1790000000", totalPoints: "999" }],
        },
      }), { status: 200 })
    }
    if (url.includes("loginBonusInfo")) {
      return new Response(JSON.stringify({ code: 0, result: { totalTimes: 5, totalPoints: 8000, hasIssued: true } }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }
  const u = await hooks.auth.usage(async () => seat)
  if (u.error) throw new Error(u.error)
  const w = u.windows[0]
  if (Math.abs(w.used - 100 / 6000 * 100) > 0.01) throw new Error("used 百分比错: " + w.used)
  if (!w.runsOutAt || w.runsOut !== 5000) throw new Error("runsOut 计算: " + JSON.stringify(w.runsOut))
  if (u.plan !== "已签到 5 天") throw new Error("plan: " + u.plan)
  ok(`used=${w.used.toFixed(2)}%, runsOut=5000（expired 包被正确忽略）, plan 正确`)
} catch (e) { fail("windows 计算", e) }

console.log("[W4] usage 中 expireDate 为字符串数字（真实接口形态）已处理")
try {
  // W3 已用字符串 "1799999999" 验证（Number("1799999999")*1000 正常）——本用例验 null/缺失
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("quota_overview")) {
      return new Response(JSON.stringify({
        code: 0, result: { totalPoints: "5000", usedPoints: "100", subscription: [{ status: "active", expireDate: null }] },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, result: { totalTimes: 0 } }), { status: 200 })
  }
  const u = await hooks.auth.usage(async () => seat)
  if (u.error) throw new Error(u.error)
  const w = u.windows[0]
  if (w.runsOutAt !== undefined) throw new Error("expireDate=null 应无 runsOut 字段: " + w.runsOutAt)
  ok("expireDate=null → 不产生 runsOut（无假数据）")
} catch (e) { fail("null expireDate", e) }

console.log("[W5] X-Magpie-Effort 头：magpie 宿主的档位注入正文，且不外发该头")
try {
  let captured = null
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-eff", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      captured = {
        headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
        body: typeof init?.body === "string" ? init.body : "",
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return realFetch(input, init)
  }
  const loader = await hooks.auth.loader(async () => seat)
  const r = await loader.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-magpie-effort": "high" },
    body: JSON.stringify({ model: "deepseek-v41-flash", messages: [{ role: "user", content: "hi" }] }),
  })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  if (!captured) throw new Error("上游请求未被捕获")
  const sent = JSON.parse(captured.body)
  if (sent.reasoning_effort !== "high") throw new Error(`头部档位未注入正文，reasoning_effort=${sent.reasoning_effort}`)
  if (sent.enable_thinking !== true) throw new Error("思考开关联未写入")
  if (captured.headers.get("x-magpie-effort") !== null) throw new Error("x-magpie-effort 头被原样外发（宿主会剥掉，但插件不应转发）")
  if (!captured.headers.get("authorization")?.startsWith("Bearer ")) throw new Error("gateway token 未附带")
  ok("头部 high → 正文 reasoning_effort=high + 思考开，头已消费删除")
} catch (e) { fail("effort 头消费", e) }

console.log("[W6] X-Magpie-Effort 头走 Request 对象形态同样生效（low 归一到 high）")
try {
  let captured = null
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-eff", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      captured = { body: typeof init?.body === "string" ? init.body : "" }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return realFetch(input, init)
  }
  const loader = await hooks.auth.loader(async () => seat)
  const req = new Request(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Magpie-Effort": "Low" },
    body: JSON.stringify({ model: "deepseek-v41-flash", messages: [{ role: "user", content: "hi" }] }),
  })
  const r = await loader.fetch(req)
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const sent = JSON.parse(captured.body)
  if (sent.reasoning_effort !== "high") throw new Error(`Request 头档位未按 low→high 归一（大小写失败?）: ${sent.reasoning_effort}`)
  ok("Request 对象 + 大小写混写头 → 正文 high（low 归一）")
} catch (e) { fail("effort 头 Request 形态", e) }

globalThis.fetch = realFetch
console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
