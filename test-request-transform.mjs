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
import { routeModel, capsPath, tapLearningStream } from "./budget.mjs"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

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

console.log("[T10] routeModel 纯函数边界：匹配键与出站键分离，规范 API ID 保真")
try {
  // trusted 是 Map：键 = 归一化查找键（小写），值 = 可信清单里的规范 API ID。
  // 匹配允许大小写归一，出站必须采用清单记录的原始规范 ID（GPT-REVIEW-V050-R1 任务一）。
  const trusted = new Map([
    ["model-text", "model-text"],
    ["glm-53", "glm-53"],
    ["dm-auto-model/text.l0", "dm-auto-model/text.L0"],
    ["dm-auto-model/text.l1", "dm-auto-model/text.L1"],
    ["dm-auto-model/text.l2", "dm-auto-model/text.L2"],
    ["dm-auto-model/mm.l0", "dm-auto-model/mm.L0"],
  ])
  if (routeModel("model-text", trusted).outbound !== "model-text") throw new Error("直通失败")
  if (routeModel("model-text", trusted).note !== null) throw new Error("直通不应带诊断")
  if (routeModel("glm-53[1M]", trusted).outbound !== "glm-53") throw new Error("[1M] 剥离失败")
  if (routeModel("glm-53[1M]", trusted).note !== "suffix") throw new Error("[1M] 应带 suffix 诊断")
  if (routeModel("dm-auto-model/text.L0", trusted).outbound !== "dm-auto-model/text.L0") {
    throw new Error("规范 ID 被改成小写出站（P0-1 复发）")
  }
  if (routeModel("dm-auto-model/text.L1", trusted).outbound !== "dm-auto-model/text.L1") {
    throw new Error("text.L1 规范 ID 被改写")
  }
  if (routeModel("dm-auto-model/mm.L0", trusted).outbound !== "dm-auto-model/mm.L0") {
    throw new Error("mm.L0 规范 ID 被改写")
  }
  if (routeModel("dm-auto-model/TEXT.l0", trusted).outbound !== "dm-auto-model/text.L0") {
    throw new Error("大小写等价名应按清单规范 ID 出站")
  }
  if (routeModel("glm-5", trusted).outbound !== "glm-53") throw new Error("glm-5 映射失败")
  if (routeModel("", trusted) !== null) throw new Error("空名应拒绝")
  if (routeModel("[1M]", trusted) !== null) throw new Error("仅后缀应拒绝")
  if (routeModel("no-such", trusted) !== null) throw new Error("未知应拒绝")
  if (routeModel(null, trusted) !== null) throw new Error("非字符串应拒绝")
  ok("routeModel 匹配归一/出站保真/边界全部符合规格")
} catch (e) { fail("routeModel 边界", e) }

console.log("[T11] fetch 级规范 ID 保真：tier 模型原样出站，网关收到的是清单原始大写 ID")
try {
  const st = captureUpstream()
  const loader = await hooks.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "dm-auto-model/text.L1", messages: [] }) })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const sent = JSON.parse(st.captured.body)
  if (sent.model !== "dm-auto-model/text.L1") {
    throw new Error(`tier 模型被改写成 ${sent.model}（云端无证据接受小写，P0-1 复发）`)
  }
  ok("dm-auto-model/text.L1 原样出站（无大小写改写）")
} catch (e) { fail("tier 规范 ID 出站", e) } finally { restore() }

console.log("[T12] 用户自定义模型兼容：config hook 注册过的模型不被路由拒绝")
try {
  const dir = join(tmpdir(), "dumate-transform-custom-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  const config = { provider: { dumate: { models: { "my-custom-model": { name: "自定义", limit: { context: 4096, output: 512 } } } } } }
  await plugin.config(config)
  const st = captureUpstream()
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "my-custom-model", messages: [] }) })
  if (r.status !== 200) throw new Error(`0.4.0 时代可用的自定义模型被 v0.5.0 拒绝（HTTP ${r.status}）——兼容性回归`)
  const sent = JSON.parse(st.captured.body)
  if (sent.model !== "my-custom-model") throw new Error("自定义模型被改写: " + sent.model)
  rmSync(dir, { recursive: true, force: true })
  ok("config hook 注册的自定义模型直通（未引入静默兜底）")
} catch (e) { fail("自定义模型兼容", e) } finally { restore() }

console.log("[T13] 400 学习真正有界：声明超限的响应体不读取、不学习、原样返回")
try {
  const dir = join(tmpdir(), "dumate-transform-bounded-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  const state = { read: false }
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-50", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      state.read = true
      return new Response(
        JSON.stringify({ error: { message: "max_tokens range is [1, 4096]" } }),
        { status: 400, headers: { "Content-Type": "application/json", "Content-Length": "999999" } },
      )
    }
    return realFetch(input, init)
  }
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", messages: [] }) })
  if (r.status !== 400) throw new Error("HTTP " + r.status)
  const body = await r.text()
  if (!body.includes("4096")) throw new Error("400 响应体未透传")
  if (existsSync(capsPath({ stateDir: dir }))) {
    throw new Error("声明 999999 字节的响应体被读取并学习（有界读取承诺被破坏）")
  }
  rmSync(dir, { recursive: true, force: true })
  ok("Content-Length 超限 → 跳过学习 + 响应体原样透传")
} catch (e) { fail("有界读取", e) } finally { restore() }

console.log("[T14] 有界读取：无 Content-Length、实际 70KB 的 400 体 → 流式计数超限即放弃学习，响应原样")
try {
  const dir = join(tmpdir(), "dumate-transform-bnd2-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  const bigBody = JSON.stringify({ error: { message: "max_tokens range is [1, 4096]" + "x".repeat(70000) } })
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-50", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      // 无 Content-Length 头（chunked/未声明场景），实际约 70KB
      return new Response(bigBody, { status: 400, headers: { "Content-Type": "application/json" } })
    }
    return realFetch(input, init)
  }
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", messages: [] }) })
  if (r.status !== 400) throw new Error("HTTP " + r.status)
  if (r.headers.get("content-type") !== "application/json") throw new Error("400 响应头丢失")
  const text = await r.text()
  if (text !== bigBody) throw new Error(`响应体未原样透传（长度 ${text.length} ≠ ${bigBody.length}）`)
  if (existsSync(capsPath({ stateDir: dir }))) {
    throw new Error("无 CL 声明的 70KB 体被完整读入并学习——有界读取未成立（R2-P1 复发）")
  }
  rmSync(dir, { recursive: true, force: true })
  ok("无 CL + 70KB → 放弃学习 + 原始错误体/状态/头原样")
} catch (e) { fail("无 CL 有界读取", e) } finally { restore() }

console.log("[T15] 有界读取：Content-Length 虚假偏小（声明 10、实际 70KB）→ 仍按实际字节计数放弃学习")
try {
  const dir = join(tmpdir(), "dumate-transform-bnd3-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  const bigBody = JSON.stringify({ error: { message: "max_tokens range is [1, 4096]" + "y".repeat(70000) } })
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-50", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      return new Response(bigBody, { status: 400, headers: { "Content-Type": "application/json", "Content-Length": "10" } })
    }
    return realFetch(input, init)
  }
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", messages: [] }) })
  if (r.status !== 400) throw new Error("HTTP " + r.status)
  const text = await r.text()
  if (text !== bigBody) throw new Error("响应体未原样透传")
  if (existsSync(capsPath({ stateDir: dir }))) {
    throw new Error("虚假偏小 CL 被信任并学习——实际字节计数未生效（R2-P1 复发）")
  }
  rmSync(dir, { recursive: true, force: true })
  ok("虚假 CL + 70KB → 按实际字节计数放弃学习 + 原样透传")
} catch (e) { fail("虚假 CL 有界读取", e) } finally { restore() }

console.log("[T16] 自定义模型生命周期：config 删除后不再可信（当前有效配置是唯一可信来源）")
try {
  const dir = join(tmpdir(), "dumate-transform-life-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  // 第一步：注册自定义模型 → 可信、可调用
  const withCustom = { provider: { dumate: { models: { "my-custom-model": { name: "自定义", limit: { context: 4096, output: 512 } } } } } }
  await plugin.config(withCustom)
  const st = captureUpstream()
  const loader = await plugin.auth.loader(async () => seat)
  const r1 = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "my-custom-model", messages: [] }) })
  if (r1.status !== 200) throw new Error(`注册后应可调用（HTTP ${r1.status}）`)
  // 第二步：重新 config 且不再包含该模型 → 必须立即失去信任
  await plugin.config({ provider: {} })
  const r2 = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "my-custom-model", messages: [] }) })
  if (r2.status !== 400) {
    throw new Error(`已从配置删除的模型仍被信任（HTTP ${r2.status}）——生命周期未与当前有效配置同步`)
  }
  rmSync(dir, { recursive: true, force: true })
  ok("先注册→再删除→重新 config → 立即 400（不残留信任）")
} catch (e) { fail("自定义模型生命周期", e) } finally { restore() }

console.log("[T17] 超大单块：单个 12MB 分块的 400 体 → 不学习、下游逐字节收全（回归哨兵）")
try {
  const dir = join(tmpdir(), "dumate-transform-huge-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  // 单个 12MB 分块，匹配串在块首（若被学习即超标）
  const prefix = new TextEncoder().encode("max_tokens range is [1, 4096]")
  const chunk = new Uint8Array(12 * 1024 * 1024)
  chunk.set(prefix, 0)
  const source = new ReadableStream({
    start(controller) { controller.enqueue(chunk); controller.close() },
  })
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-50", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      return new Response(source, { status: 400, headers: { "Content-Type": "application/json" } })
    }
    return realFetch(input, init)
  }
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", messages: [] }) })
  if (r.status !== 400) throw new Error("HTTP " + r.status)
  const received = new Uint8Array(await r.arrayBuffer())
  if (received.length !== chunk.length) throw new Error(`下游收到 ${received.length} 字节 ≠ 原始 ${chunk.length}（12MB 单块被截断）`)
  for (let i = 0; i < prefix.length; i++) {
    if (received[i] !== prefix[i]) throw new Error("块首匹配串字节被改写")
  }
  if (existsSync(capsPath({ stateDir: dir }))) {
    throw new Error("12MB 超限体被学习（总量计数失效）")
  }
  rmSync(dir, { recursive: true, force: true })
  ok("12MB 单块：不学习 + 下游逐字节收全（旁路采样不为学习暂存大块）")
} catch (e) { fail("超大单块", e) } finally { restore() }

console.log("[T18] 字节保真：非法 UTF-8 的短错误体逐字节透传（不得 decode→re-encode 改写）")
try {
  const dir = join(tmpdir(), "dumate-transform-utf8-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  // 9 字节、含非法 UTF-8 序列（0xFF 0xFE）——TextDecoder 会替换成 U+FFFD 再重编码变 11 字节
  const raw = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0xfd, 0x7d])
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-50", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      return new Response(raw, { status: 400, headers: { "Content-Type": "application/json" } })
    }
    return realFetch(input, init)
  }
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", messages: [] }) })
  if (r.status !== 400) throw new Error("HTTP " + r.status)
  const received = new Uint8Array(await r.arrayBuffer())
  if (received.length !== raw.length) {
    throw new Error(`字节保真被破坏：9 字节变成 ${received.length} 字节（decode→re-encode 复发，R3 反例 B）`)
  }
  for (let i = 0; i < raw.length; i++) {
    if (received[i] !== raw[i]) throw new Error(`第 ${i} 字节被改写: ${raw[i]}→${received[i]}`)
  }
  rmSync(dir, { recursive: true, force: true })
  ok("非法 UTF-8 短体逐字节保真（原始字节直通，零重编码）")
} catch (e) { fail("字节保真", e) } finally { restore() }

console.log("[T19] tapLearningStream 合约：旁路样本 ≤8KB、总量 >65536 放弃、完整消费才学习")
try {
  const dir = join(tmpdir(), "dumate-transform-tap-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const capsFile = capsPath({ stateDir: dir })
  const encoder = new TextEncoder()
  // 场景 1：单个 12MB 块（反例 A 直测新 API）→ 超限放弃，下游字节不变
  {
    const huge = new Uint8Array(12 * 1024 * 1024)
    huge.set(encoder.encode("max_tokens range is [1, 4096]"), 0)
    const src = new ReadableStream({ start(c) { c.enqueue(huge); c.close() } })
    let learned = 0
    const out = tapLearningStream(new Response(src, { status: 400 }), { onLearn: () => { learned++ } })
    const got = new Uint8Array(await new Response(out).arrayBuffer())
    if (got.length !== huge.length) throw new Error("12MB 单块透传不完整")
    if (learned !== 0) throw new Error("超限后仍学习")
  }
  // 场景 2：未超限 + 命中官方格式 + 完整消费 → 学习恰一次
  {
    const src = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(JSON.stringify({ error: { message: "max_tokens range is [1, 4096]" } })))
        c.close()
      },
    })
    let learned = 0
    const out = tapLearningStream(new Response(src, { status: 400 }), { onLearn: (cap) => { learned++; if (cap !== 4096) throw new Error("cap 错误") } })
    await new Response(out).arrayBuffer()
    if (learned !== 1) throw new Error(`完整消费后应学习一次，实际 ${learned}`)
  }
  // 场景 3：下游不消费（取消）→ 放弃学习
  {
    const src = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(JSON.stringify({ error: { message: "max_tokens range is [1, 4096]" } })))
        c.close()
      },
    })
    let learned = 0
    const out = tapLearningStream(new Response(src, { status: 400 }), { onLearn: () => { learned++ } })
    const reader = out.getReader()
    await reader.read()          // 只读一块
    await reader.cancel()        // 中途取消
    await new Promise((r) => setTimeout(r, 50))
    if (learned !== 0) throw new Error("下游取消后仍学习（违反「不消费即放弃」）")
  }
  // 场景 4：样本上限——总量 <65536 但匹配串在 8KB 之外 → 不学习
  {
    const body = encoder.encode(JSON.stringify({ error: { message: "x".repeat(9000) + "max_tokens range is [1, 4096]" } }))
    const src = new ReadableStream({ start(c) { c.enqueue(body); c.close() } })
    let learned = 0
    const out = tapLearningStream(new Response(src, { status: 400 }), { onLearn: () => { learned++ } })
    await new Response(out).arrayBuffer()
    if (learned !== 0) throw new Error("8KB 样本窗外的匹配被学习")
  }
  rmSync(dir, { recursive: true, force: true })
  ok("12MB 超限放弃 / 完整消费学习恰一次 / 取消不学习 / 8KB 样本窗")
} catch (e) { fail("tapLearningStream 合约", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
