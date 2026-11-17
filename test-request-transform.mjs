// v0.5.0 Cycle1+Cycle3：请求变换面 —— 身份头 / 模型路由 / 单次解析诊断
// 依据 dumate2api（wearetheone777/dumate2api）已实证的云端链路要求复核修订：
//   - 云端网关要求 X-Dumate-Client-Type / X-Dumate-Account-Id 两个身份头（其
//     src/web-pool.js 只发这三个身份字段，纯 Bearer 即通）；v0.4.0 的 qwen4-max
//     400 "required headers invalid" 是「缺头」假设，本套件只验证插件确实补头，
//     不预设上游必然恢复 200（live 验收另行核对）。
//   - 模型名路由：可信清单直通；[1M] 只剥后缀；glm-5→glm-53 是「版本替代」
//     映射必须留诊断；未知模型显式拒绝，绝不静默兜底成 model-text。
// 全部离线（mock globalThis.fetch）。
import { DuMatePlugin } from "./index.mjs"
import { routeModel } from "./budget.mjs"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const cookies = [{ name: "bce-sessionid", value: "v50", domain: ".baidu.com" }]
const seat = { type: "oauth", cookies, source: "manual", name: "用户甲", accountId: "acc-50" }
const hooks = await DuMatePlugin({})
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
const realFetch = globalThis.fetch

// 统一的 mock 上游：捕获出站请求，返回 200。
function captureUpstream() {
  const state = { captured: null, calls: 0 }
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-50", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      state.calls++
      state.captured = {
        headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
        body: typeof init?.body === "string" ? init.body : "",
        url,
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return realFetch(input, init)
  }
  return state
}
const restore = () => { globalThis.fetch = realFetch }

console.log("[T1] 身份头：出站带 X-Dumate-Client-Type:web 与 X-Dumate-Account-Id（真实 accountId）")
try {
  const st = captureUpstream()
  const loader = await hooks.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", messages: [] }) })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  if (st.captured.headers.get("x-dumate-client-type") !== "web") throw new Error("缺 X-Dumate-Client-Type: web")
  if (st.captured.headers.get("x-dumate-account-id") !== "acc-50") throw new Error(`accountId 应取自当前 auth，得到 ${st.captured.headers.get("x-dumate-account-id")}`)
  ok("web + 真实 accountId 两个身份头已补")
} catch (e) { fail("身份头注入", e) } finally { restore() }

console.log("[T2] 身份头防伪造：调用方带入的同名头被插件覆盖")
try {
  const st = captureUpstream()
  const loader = await hooks.auth.loader(async () => seat)
  await loader.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dumate-Client-Type": "evil", "X-Dumate-Account-Id": "someone-else" },
    body: JSON.stringify({ model: "model-text", messages: [] }),
  })
  if (st.captured.headers.get("x-dumate-client-type") !== "web") throw new Error("伪造 client-type 未被覆盖")
  if (st.captured.headers.get("x-dumate-account-id") !== "acc-50") throw new Error("伪造 accountId 未被覆盖")
  ok("插件按当前登录态覆盖入站伪造身份头")
} catch (e) { fail("身份头防伪造", e) } finally { restore() }

console.log("[T3] accountId 缺失或非法 → 固定 global（不跨账号复用）")
try {
  const st = captureUpstream()
  for (const bad of [undefined, "", "bad id 带空格", `${"x".repeat(80)}`]) {
    const s = { ...seat, accountId: bad }
    const loader = await hooks.auth.loader(async () => s)
    await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", messages: [] }) })
    const got = st.captured.headers.get("x-dumate-account-id")
    if (got !== "global") throw new Error(`accountId=${JSON.stringify(bad)?.slice(0, 12)} 应回落 global，得到 ${got}`)
  }
  ok("缺失/空/含空格/超长 → global")
} catch (e) { fail("accountId 回落", e) } finally { restore() }

console.log("[T4] magpie 专属头全族不外发（不止 x-magpie-effort）")
try {
  const st = captureUpstream()
  const loader = await hooks.auth.loader(async () => seat)
  await loader.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-magpie-effort": "low", "x-magpie-route": "abc", "x-magpie-anything": "1" },
    body: JSON.stringify({ model: "model-text", messages: [] }),
  })
  for (const h of ["x-magpie-effort", "x-magpie-route", "x-magpie-anything"]) {
    if (st.captured.headers.get(h) !== null) throw new Error(`${h} 被外发`)
  }
  ok("x-magpie-* 全部剥离")
} catch (e) { fail("magpie 头剥离", e) } finally { restore() }

console.log("[T5] 可信清单模型直通：请求体逐字节不变，无路由诊断头")
try {
  const st = captureUpstream()
  const loader = await hooks.auth.loader(async () => seat)
  const body = JSON.stringify({ model: "glm-53", messages: [], temperature: 0.7 })
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json", "x-magpie-effort": "high" }, body })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  if (st.captured.body !== body) throw new Error("可信模型请求体被改写（应逐字节一致）")
  if (r.headers.get("x-magpie-dumate-route")) throw new Error("未发生改写却带了路由诊断头")
  ok("glm-53 + 头部档位：请求体零改写（C13 语义在 fetch 面同样成立）")
} catch (e) { fail("可信直通", e) } finally { restore() }

console.log("[T6] [1M] 后缀剥离：glm-53[1M] → glm-53，带路由诊断头")
try {
  const st = captureUpstream()
  const loader = await hooks.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-53[1M]", messages: [] }) })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const sent = JSON.parse(st.captured.body)
  if (sent.model !== "glm-53") throw new Error("[1M] 未剥离: " + sent.model)
  const route = r.headers.get("x-magpie-dumate-route")
  if (!route || route !== "glm-53[1M]=>glm-53") throw new Error("路由诊断头缺失或不符: " + route)
  ok("[1M] 剥离 + 诊断头 original=>outbound")
} catch (e) { fail("[1M] 剥离", e) } finally { restore() }

console.log("[T7] glm-5 → glm-53 版本替代映射：出站改名且诊断头记录替代关系")
try {
  const st = captureUpstream()
  const loader = await hooks.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-5", messages: [] }) })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const sent = JSON.parse(st.captured.body)
  if (sent.model !== "glm-53") throw new Error("glm-5 未映射: " + sent.model)
  if (r.headers.get("x-magpie-dumate-route") !== "glm-5=>glm-53") throw new Error("替代关系未记录")
  ok("glm-5→glm-53 出站改名 + 诊断（不伪称同一模型）")
} catch (e) { fail("glm-5 替代映射", e) } finally { restore() }

console.log("[T8] 未知模型显式拒绝：400 + 明确报错，上游零调用，token 不消耗")
try {
  const st = captureUpstream()
  const loader = await hooks.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "totally-unknown-model", messages: [] }) })
  if (r.status !== 400) throw new Error(`未知模型应 400，得到 ${r.status}`)
  if (st.calls !== 0) throw new Error("未知模型不应触发上游调用")
  const payload = await r.json()
  if (!/unknown|未知|not a known/i.test(payload?.error?.message ?? "")) throw new Error("错误信息未说明模型未知: " + payload?.error?.message)
  ok("未知模型 400 拒绝 + 上游零调用（不静默兜底 model-text）")
} catch (e) { fail("未知模型拒绝", e) } finally { restore() }

console.log("[T9] 非 JSON 请求体安全透传（不做任何改写也不报错）")
try {
  const st = captureUpstream()
  const loader = await hooks.auth.loader(async () => seat)
  const raw = "this is not json at all"
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "text/plain" }, body: raw })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  if (st.captured.body !== raw) throw new Error("非 JSON 体被改写")
  ok("非 JSON 体逐字节透传")
} catch (e) { fail("非 JSON 透传", e) } finally { restore() }

console.log("[T10] routeModel 纯函数边界：空名/仅后缀/大小写")
try {
  const trusted = new Set(["model-text", "glm-53", "dm-auto-model/text.l0"])
  if (routeModel("model-text", trusted).outbound !== "model-text") throw new Error("直通失败")
  if (routeModel("model-text", trusted).note !== null) throw new Error("直通不应带诊断")
  if (routeModel("glm-53[1M]", trusted).outbound !== "glm-53") throw new Error("[1M] 剥离失败")
  if (routeModel("glm-53[1M]", trusted).note !== "suffix") throw new Error("[1M] 应带 suffix 诊断")
  if (routeModel("dm-auto-model/text.L0", trusted).outbound !== "dm-auto-model/text.l0") throw new Error("大小写归一失败")
  if (routeModel("glm-5", trusted).outbound !== "glm-53") throw new Error("glm-5 映射失败")
  if (routeModel("", trusted) !== null) throw new Error("空名应拒绝")
  if (routeModel("[1M]", trusted) !== null) throw new Error("仅后缀应拒绝")
  if (routeModel("no-such", trusted) !== null) throw new Error("未知应拒绝")
  if (routeModel("MODEL-TEXT", trusted)?.outbound !== "model-text") throw new Error("大小写未归一")
  if (routeModel(null, trusted) !== null) throw new Error("非字符串应拒绝")
  ok("routeModel 边界全部符合规格")
} catch (e) { fail("routeModel 边界", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
