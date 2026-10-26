// 第十八轮：升级场景模拟——插件文件更新后 magpie 端的seat是否兼容（旧 auth 形态 + 新代码）
// 覆盖：旧版 seat（无 source 字段）→ refresh/loader/usage 不崩；seat.cookies 里混入异常条目。
import { DuMatePlugin } from "./index.mjs"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const hooks = await DuMatePlugin({})

console.log("[U1] 旧版 seat（无 source 字段）→ 全钩子不崩")
try {
  const oldSeat = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "old", domain: ".baidu.com" }], accountId: "a", name: "旧" }
  const u = await hooks.auth.usage(async () => oldSeat)
  // 会真调 console（旧 cookie 无效→HTML 登录页）→ error + expired，而不是崩溃
  if (typeof u.error === "undefined" && typeof u.balance === "undefined") throw new Error("usage 返回异常形态")
  const c = await hooks.auth.checkin(async () => oldSeat)
  if (!["done", "claimed", "inactive", "failed"].includes(c.outcome)) throw new Error("checkin 异常 outcome")
  const r = await hooks.auth.refresh(oldSeat)
  // source 不是 desktop → undefined（不跟随）
  if (r !== undefined) throw new Error("无 source 字段应不触发 refresh 跟随")
  ok(`usage/checkin 优雅降级、refresh 不误触发`)
} catch (e) { fail("旧版 seat", e) }

console.log("[U2] seat.cookies 混入脏条目（缺 name / 缺 domain / 值含分号）")
try {
  const dirty = [
    { value: "no-name" },                                            // 缺 name
    { name: "", value: "empty-name", domain: ".baidu.com" },         // 空 name
    { name: "bce-sessionid", value: "a;b=c", domain: ".baidu.com" }, // 值含分号
    { name: "good", value: "1", domain: ".baidu.com" },
  ]
  const seat = { type: "oauth", cookies: dirty, source: "manual" }
  // cookieHeaderOf 直接拼（buildCookieHeader 只在 consolePost 用）——验证 header 生成不抛
  const l = await hooks.auth.loader(async () => seat)
  const realFetch = globalThis.fetch
  let capturedHeader = ""
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("token/get")) {
      capturedHeader = init?.headers?.Cookie ?? ""
      return new Response(JSON.stringify({ code: 0, result: { token: "t", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
  }
  await l.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", messages: [{ role: "user", content: "x" }] }) })
  globalThis.fetch = realFetch
  if (!capturedHeader) throw new Error("header 未捕获")
  ok(`脏 cookie 不崩（header 长度 ${capturedHeader.length}）`)
} catch (e) { fail("脏 cookie", e) }

console.log("[U3] auth.cookies 是 JSON 字符串而非数组（形态防御）")
try {
  const badSeat = { type: "oauth", cookies: "[{not array}]", source: "manual" }
  const u = await hooks.auth.usage(async () => badSeat)
  // 提示语已本地化（原英文 "not signed in"），断言只校验"被判为未登录"，不锁死措辞
  if (!/未登录|没有登录信息/.test(String(u.error ?? ""))) throw new Error("应判未登录: " + JSON.stringify(u).slice(0, 80))
  ok("字符串 cookies → 未登录降级")
} catch (e) { fail("字符串 cookies", e) }

console.log("[U4] getAuth 抛异常时 loader/usage 不崩")
try {
  const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
  const l = await hooks.auth.loader(async () => { throw new Error("seat 存取失败") })
  const r = await l.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", messages: [{ role: "user", content: "x" }] }) })
  if (r.status !== 401 && r.status !== 502) throw new Error("应 401/502: " + r.status)
  const u = await hooks.auth.usage(async () => { throw new Error("boom") })
  if (!u.error) throw new Error("usage 应捕获")
  ok(`getAuth 抛错 → ${r.status} / usage 降级`)
} catch (e) { fail("getAuth 抛错", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
