// v0.5.0 Cycle2+Cycle4：预算钳制 + 上限自学习
// 依据 dumate2api（wearetheone777/dumate2api）的实测结论复核修订：
//   - 长推理任务在小 max_tokens 下会出现「思考耗尽预算、正文 0」→ floor 抬升，
//     但**只对有实测依据的模型启用**（第一阶段仅 deepseek-v41-flash），其余模型
//     维持既有显式预算行为；env 开关可整体关闭抬升。
//   - 上限优先级：学习值 > 已验证静态上限 > 未知默认。text.L1 的 2000000 是
//     「实测可接受值」，不是已探明硬上限，文档不得宣称硬上限。
//   - cap < floor 时以 cap 为准（绝不为凑下限越上游限制）。
//   - 上限学习只认官方网关 400 的 max_tokens 范围错误；按归一后模型键存储；
//     TTL 7 天；原子写 0600/0700；损坏容错；本版本不自动重试。
// 全部离线（mock globalThis.fetch）。
import { DuMatePlugin } from "./index.mjs"
import {
  resolveMaxTokens, applyBudget, routeModel,
  learnCapFromBody, loadCaps, saveCap, capsPath,
  OUTPUT_CAPS, FLOOR, DEFAULT_BUDGET, DEFAULT_CAP, FLOOR_ENABLED,
} from "./budget.mjs"
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const cookies = [{ name: "bce-sessionid", value: "v50", domain: ".baidu.com" }]
const seat = { type: "oauth", cookies, source: "manual", name: "用户甲", accountId: "acc-50" }
const hooks50 = await DuMatePlugin({})
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
const realFetch = globalThis.fetch

function captureUpstream(responses = {}) {
  const state = { captured: [], calls: 0 }
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-50", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      state.calls++
      state.captured.push({
        headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
        body: typeof init?.body === "string" ? init.body : "",
      })
      const hit = responses[state.calls - 1] ?? responses.default
      return hit ?? new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return realFetch(input, init)
  }
  return state
}
const restore = () => { globalThis.fetch = realFetch }

// ---- 纯函数层 ---------------------------------------------------------------

console.log("[B1] resolveMaxTokens 纯函数矩阵（floor/default/cap/边界）")
try {
  const P = { floor: 65536, defaultBudget: 32768, cap: 131072 }
  // 缺省 → defaultBudget → floor 抬升
  if (resolveMaxTokens(undefined, P) !== 65536) throw new Error("缺省应抬到 floor")
  if (resolveMaxTokens(null, P) !== 65536) throw new Error("null 应抬到 floor")
  // 显式小预算 → 抬升
  if (resolveMaxTokens(1000, P) !== 65536) throw new Error("1000 应抬到 floor")
  // 超上限 → 钳到 cap
  if (resolveMaxTokens(200000, P) !== 131072) throw new Error("200000 应钳到 cap")
  // cap < floor → cap 为准
  if (resolveMaxTokens(1000, { floor: 65536, defaultBudget: 32768, cap: 40000 }) !== 40000) {
    throw new Error("cap<floor 应以 cap 为准")
  }
  // 非法值全部落 default 再走 floor/cap
  for (const bad of [NaN, "1000", 0, -5, 1.5, 1e21, Infinity, {}]) {
    if (resolveMaxTokens(bad, P) !== 65536) throw new Error("非法值 " + String(bad) + " 应落 default→floor")
  }
  // floor=0（关闭抬升）→ 缺省落 default，显式值原样（仍受 cap 钳制）
  const OFF = { floor: 0, defaultBudget: 32768, cap: 131072 }
  if (resolveMaxTokens(undefined, OFF) !== 32768) throw new Error("floor=0 缺省应落 defaultBudget")
  if (resolveMaxTokens(1000, OFF) !== 1000) throw new Error("floor=0 显式小值应原样")
  if (resolveMaxTokens(999999, OFF) !== 131072) throw new Error("floor=0 仍应受 cap 钳制")
  // 无 cap → 不钳
  if (resolveMaxTokens(200000, { floor: 0, defaultBudget: 32768 }) !== 200000) throw new Error("无 cap 不应钳制")
  // 安全整数上限：Number.MAX_SAFE_INTEGER 合法但被 cap 钳住
  if (resolveMaxTokens(Number.MAX_SAFE_INTEGER, P) !== 131072) throw new Error("极大安全整数应被 cap 钳住")
  ok("缺省/抬升/钳制/cap<floor/非法值/floor=0/无cap 全部符合规格")
} catch (e) { fail("resolveMaxTokens 矩阵", e) }

console.log("[B2] applyBudget 按模型策略：floor 仅 deepseek；其余模型不注入不抬升")
try {
  const env = {}
  const ds = applyBudget({ model: "deepseek-v41-flash", messages: [] }, { env })
  if (ds.max_tokens !== 65536) throw new Error("deepseek 缺省应抬到 65536: " + ds.max_tokens)
  const dsSmall = applyBudget({ model: "deepseek-v41-flash", max_tokens: 1000, messages: [] }, { env })
  if (dsSmall.max_tokens !== 65536) throw new Error("deepseek 1000 应抬升")
  const glm = applyBudget({ model: "glm-53", messages: [] }, { env })
  if ("max_tokens" in glm) throw new Error("glm-53 缺省不应注入 max_tokens（维持既有行为）")
  const glmSmall = applyBudget({ model: "glm-53", max_tokens: 1000, messages: [] }, { env })
  if (glmSmall.max_tokens !== 1000) throw new Error("glm-53 显式 1000 应原样（floor 未启用）")
  const mt = applyBudget({ model: "model-text", max_tokens: 500000, messages: [] }, { env })
  if (mt.max_tokens !== OUTPUT_CAPS["model-text"]) throw new Error("model-text 超静态上限应被钳制")
  ok("floor 仅 deepseek；其他模型只做保护性 cap 钳制")
} catch (e) { fail("applyBudget 策略", e) }

console.log("[B3] 策略开关：MAGPIE_DUMATE_BUDGET=off 关闭抬升（原始透传退出路径）")
try {
  const env = { MAGPIE_DUMATE_BUDGET: "off" }
  const ds = applyBudget({ model: "deepseek-v41-flash", max_tokens: 1000, messages: [] }, { env })
  if (ds.max_tokens !== 1000) throw new Error("off 后显式 1000 应原样: " + ds.max_tokens)
  const dsBare = applyBudget({ model: "deepseek-v41-flash", messages: [] }, { env })
  if ("max_tokens" in dsBare) throw new Error("off 后缺省不应注入 max_tokens")
  ok("off 开关生效（含缺省不注入）")
} catch (e) { fail("策略开关", e) }

console.log("[B4] FLOOR_ENABLED 白名单：仅 deepseek-v41-flash；静态表不含未验证值")
try {
  if (FLOOR_ENABLED.size !== 1 || !FLOOR_ENABLED.has("deepseek-v41-flash")) {
    throw new Error("第一阶段 floor 白名单应只有 deepseek-v41-flash: " + [...FLOOR_ENABLED])
  }
  if (FLOOR !== 65536 || DEFAULT_BUDGET !== 32768) throw new Error("FLOOR/DEFAULT_BUDGET 数值与设计不符")
  // text.L1 的 2000000 必须以「实测可接受」语义存在，且不夸大
  if (OUTPUT_CAPS["dm-auto-model/text.L1"] !== 2000000) throw new Error("text.L1 静态上限缺失")
  if (DEFAULT_CAP !== 131072) throw new Error("未知模型默认 cap 应为 131072（通道实测可接受值）")
  ok("白名单/常量符合第一阶段范围")
} catch (e) { fail("FLOOR 白名单", e) }

console.log("[B4b] 模型专属上限命中（大小写一致）：L1/L0/L2 各自命中静态表，不落默认值")
try {
  const env = {}
  // 请求值远超各模型静态上限 → 钳制结果必须等于静态表值（GPT-REVIEW-V050-R1 任务二）
  const l1 = applyBudget({ model: "dm-auto-model/text.L1", max_tokens: 5000000, messages: [] }, { env })
  if (l1.max_tokens !== 2000000) throw new Error(`text.L1 未命中 2000000（落到 ${l1.max_tokens} = 大小写失配回退默认值）`)
  const l0 = applyBudget({ model: "dm-auto-model/text.L0", max_tokens: 500000, messages: [] }, { env })
  if (l0.max_tokens !== 393216) throw new Error(`text.L0 未命中 393216（得到 ${l0.max_tokens}）`)
  const l2 = applyBudget({ model: "dm-auto-model/text.L2", max_tokens: 500000, messages: [] }, { env })
  if (l2.max_tokens !== 131072) throw new Error(`text.L2 未命中 131072（得到 ${l2.max_tokens}）`)
  const mt = applyBudget({ model: "model-text", max_tokens: 500000, messages: [] }, { env })
  if (mt.max_tokens !== 393216) throw new Error(`model-text 未命中 393216（得到 ${mt.max_tokens}）`)
  ok("text.L1→2000000、text.L0→393216、text.L2→131072、model-text→393216 全部命中")
} catch (e) { fail("专属上限命中", e) }

console.log("[B4c] 学习缓存键与出站 ID 统一：规范大小写写入可被命中（含等价大小写查询）")
try {
  const env = {}
  const caps = { "dm-auto-model/text.L1": { cap: 1500000, at: Date.now() } }
  const exact = applyBudget({ model: "dm-auto-model/text.L1", max_tokens: 5000000, messages: [] }, { env, caps })
  if (exact.max_tokens !== 1500000) throw new Error(`学习值未按出站键命中（得到 ${exact.max_tokens}）`)
  const equivalent = applyBudget({ model: "dm-auto-model/text.l1", max_tokens: 5000000, messages: [] }, { env, caps })
  if (equivalent.max_tokens !== 1500000) throw new Error(`等价大小写的学习键未命中（得到 ${equivalent.max_tokens}）`)
  ok("学习缓存按出站模型键命中（大小写不敏感查找，键保留规范形态）")
} catch (e) { fail("学习键统一", e) }

console.log("[B5] learnCapFromBody 三种官方错误格式；非范围型 400 不学习")
try {
  if (learnCapFromBody(JSON.stringify({ error: { message: "max_tokens range is [1, 4096]" } })) !== 4096) {
    throw new Error("qianfan 范围格式未识别")
  }
  if (learnCapFromBody(JSON.stringify({ error: { message: "max_tokens 不能超过 8192" } })) !== 8192) {
    throw new Error("中文上限格式未识别")
  }
  if (learnCapFromBody(JSON.stringify({ error: { message: "Range of max_tokens is 1 to 16384" } })) !== 16384) {
    throw new Error("Range 格式未识别")
  }
  for (const junk of [
    JSON.stringify({ error: { message: "quota exceeded" } }),
    JSON.stringify({ error: { message: "required headers invalid" } }),
    "not json",
    JSON.stringify({ error: { message: "max_tokens range is [1, bogus]" } }),
  ]) {
    if (learnCapFromBody(junk) !== null) throw new Error("非范围型错误不应学习: " + junk.slice(0, 40))
  }
  ok("3 种格式识别 + 3 类干扰不误学")
} catch (e) { fail("learnCapFromBody", e) }

console.log("[B6] caps 持久化：原子写/权限 0600·0700/无凭据字段/损坏容错/TTL")
try {
  const dir = join(tmpdir(), "dumate-budget-test-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const path = capsPath({ stateDir: dir })
  const now = Date.now()
  saveCap(path, "deepseek-v41-flash", 4096, now)
  saveCap(path, "glm-53", 8192, now)
  // 原子写：不留 .tmp 残留
  const leftovers = readdirSync(join(dir, "magpie-dumate")).filter((f) => f.endsWith(".tmp"))
  if (leftovers.length) throw new Error("残留 tmp 文件: " + leftovers)
  // 权限
  const st = statSync(path)
  if ((st.mode & 0o777) !== 0o600) throw new Error("caps.json 权限应为 0600: " + (st.mode & 0o777).toString(8))
  const dirSt = statSync(join(dir, "magpie-dumate"))
  if ((dirSt.mode & 0o777) !== 0o700) throw new Error("目录权限应为 0700: " + (dirSt.mode & 0o777).toString(8))
  // 内容纯净：只有 cap/at，绝无凭据/prompt 类字段
  const raw = readFileSync(path, "utf8")
  for (const bad of ["cookie", "token", "Bearer", "messages", "prompt", "apiKey", dir]) {
    if (raw.toLowerCase().includes(bad.toLowerCase())) throw new Error("caps.json 混入敏感/无关字段: " + bad)
  }
  const caps = loadCaps(path, now + 1000)
  if (caps["deepseek-v41-flash"]?.cap !== 4096 || caps["glm-53"]?.cap !== 8192) throw new Error("读回不一致")
  // TTL：7 天前写入的条目不再返回
  const stale = loadCaps(path, now + 8 * 24 * 3600e3)
  if (Object.keys(stale).length !== 0) throw new Error("TTL 过期条目未失效")
  // 损坏容错
  writeFileSync(path, "corrupted-not-json{{{")
  if (Object.keys(loadCaps(path, now)).length !== 0) throw new Error("损坏文件未容错")
  // 再写一次能自愈（损坏文件被覆盖）
  saveCap(path, "deepseek-v41-flash", 16384, now)
  if (loadCaps(path, now + 10)["deepseek-v41-flash"]?.cap !== 16384) throw new Error("损坏后未能自愈写回")
  rmSync(dir, { recursive: true, force: true })
  ok("原子写 + 0600/0700 + 内容纯净 + TTL + 损坏自愈")
} catch (e) { fail("caps 持久化", e) }

console.log("[B7] 学习键绑定归一后模型：glm-5 的 400 学习记到 glm-53 名下")
try {
  const dir = join(tmpdir(), "dumate-budget-test-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const path = capsPath({ stateDir: dir })
  const now = Date.now()
  // 出站 glm-5→glm-53（routeModel），学习必须落在 glm-53
  const outbound = routeModel("glm-5").outbound
  saveCap(path, outbound, 7777, now)
  const caps = loadCaps(path, now + 10)
  if (caps["glm-53"]?.cap !== 7777) throw new Error("学习键未按归一后模型存储")
  if (caps["glm-5"]) throw new Error("不应以原始名存储")
  rmSync(dir, { recursive: true, force: true })
  ok("学习键 = routeModel 出站名")
} catch (e) { fail("学习键归一", e) }

// ---- fetch 集成层 -----------------------------------------------------------

console.log("[B8] fetch 集成：deepseek 1000+high 出站抬到 65536（防止思考耗尽预算）")
try {
  const st = captureUpstream()
  const loader = await hooks50.auth.loader(async () => seat)
  const r = await loader.fetch(GW, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-magpie-effort": "high" },
    body: JSON.stringify({ model: "deepseek-v41-flash", max_tokens: 1000, messages: [{ role: "user", content: "hi" }] }),
  })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const sent = JSON.parse(st.captured[0].body)
  if (sent.max_tokens !== 65536) throw new Error("max_tokens 应抬升 65536: " + sent.max_tokens)
  if (sent.reasoning_effort !== "high") throw new Error("推理档位丢失（v0.4.0 行为回归）")
  ok("max_tokens 1000→65536 且档位行为不变")
} catch (e) { fail("集成 floor", e) } finally { restore() }

console.log("[B9] fetch 集成：glm-53 显式 1000 原样、缺省不注入；超静态上限被钳")
try {
  const st = captureUpstream()
  const loader = await hooks50.auth.loader(async () => seat)
  const r1 = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-53", max_tokens: 1000, messages: [] }) })
  const s1 = JSON.parse(st.captured[0].body)
  if (s1.max_tokens !== 1000) throw new Error("glm-53 显式 1000 被改写: " + s1.max_tokens)
  await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-53", messages: [] }) })
  const s2 = JSON.parse(st.captured[1].body)
  if ("max_tokens" in s2) throw new Error("glm-53 缺省被注入 max_tokens")
  await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 500000, messages: [] }) })
  const s3 = JSON.parse(st.captured[2].body)
  if (s3.max_tokens !== OUTPUT_CAPS["model-text"]) throw new Error("model-text 超上限未被钳制")
  ok("glm-53 原样/缺省不注入 + model-text 保护性钳制")
} catch (e) { fail("集成 非floor模型", e) } finally { restore() }

console.log("[B10] fetch 集成：400 学习→落盘→下次请求用学习上限（cap<floor 以 cap 为准）")
try {
  const dir = join(tmpdir(), "dumate-budget-itest-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const hooks = await DuMatePlugin({ directory: dir })
  const st = captureUpstream({
    0: new Response(JSON.stringify({ error: { message: "max_tokens range is [1, 4096]", code: "range" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
  })
  const loader = await hooks.auth.loader(async () => seat)
  // 第一次：400 上来，学习 cap=4096（deepseek requested 8000 > 4096）
  const r1 = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", max_tokens: 8000, messages: [] }) })
  if (r1.status !== 400) throw new Error("第一次应透传上游 400，得到 " + r1.status)
  const body1 = await r1.text()
  if (!body1.includes("4096")) throw new Error("400 响应体未透传给调用方")
  if (!existsSync(capsPath({ stateDir: dir }))) throw new Error("学习结果未落盘")
  // 第二次：学习上限生效（8000→floor 65536→cap 4096）
  const r2 = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", max_tokens: 8000, messages: [] }) })
  if (r2.status !== 200) throw new Error("第二次应 200，得到 " + r2.status)
  const sent2 = JSON.parse(st.captured[1].body)
  if (sent2.max_tokens !== 4096) throw new Error("学习上限未生效（cap 应赢过 floor）: " + sent2.max_tokens)
  rmSync(dir, { recursive: true, force: true })
  ok("400 透传 + 学习落盘 + 下次 cap 生效（cap 赢 floor）")
} catch (e) { fail("集成 学习", e) } finally { restore() }

console.log("[B11] 学习安全：无关 400 不学习；写盘失败不影响响应；响应头保留")
try {
  const dir = join(tmpdir(), "dumate-budget-itest-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const hooks = await DuMatePlugin({ directory: dir })
  // 无关 400：不得学习
  const st1 = captureUpstream({
    default: new Response(JSON.stringify({ error: { message: "required headers invalid" } }), { status: 400, headers: { "Content-Type": "application/json", "X-Trace": "t1" } }),
  })
  const loader1 = await hooks.auth.loader(async () => seat)
  const r = await loader1.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", messages: [] }) })
  if (r.status !== 400) throw new Error("无关 400 应透传")
  if (r.headers.get("x-trace") !== "t1") throw new Error("400 响应头丢失")
  if (existsSync(capsPath({ stateDir: dir }))) throw new Error("无关 400 被误学习")
  restore()
  // 写盘失败（只读目录）：响应不受影响
  const roDir = join(tmpdir(), "dumate-budget-ro-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(join(roDir, "magpie-dumate"), { recursive: true })
  chmodSync(join(roDir, "magpie-dumate"), 0o500)
  const hooks2 = await DuMatePlugin({ directory: roDir })
  const st2 = captureUpstream({
    default: new Response(JSON.stringify({ error: { message: "max_tokens range is [1, 4096]" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
  })
  const loader2 = await hooks2.auth.loader(async () => seat)
  const r2 = await loader2.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", messages: [] }) })
  if (r2.status !== 400) throw new Error("写盘失败时 400 响应被破坏: " + r2.status)
  chmodSync(join(roDir, "magpie-dumate"), 0o700)
  rmSync(roDir, { recursive: true, force: true })
  ok("无关 400 不学习 + 写盘失败降级不影响响应 + 响应头保留")
} catch (e) { fail("学习安全", e) } finally { restore() }

console.log("[B12] 学习读取有界：超长错误体只分析前 8KB（匹配在界内则学习，界外不学）")
try {
  const dir = join(tmpdir(), "dumate-budget-itest-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const hooks = await DuMatePlugin({ directory: dir })
  const pad = "x".repeat(9000)
  const st = captureUpstream({
    default: new Response(JSON.stringify({ error: { message: pad + "max_tokens range is [1, 4096]" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
  })
  const loader = await hooks.auth.loader(async () => seat)
  await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v41-flash", messages: [] }) })
  const raw = existsSync(capsPath({ stateDir: dir })) ? readFileSync(capsPath({ stateDir: dir }), "utf8") : ""
  if (raw.includes("4096")) throw new Error("超出 8KB 分析窗的匹配不应被学习（有界读取承诺）")
  rmSync(dir, { recursive: true, force: true })
  ok("分析窗有界（9000 字符填充 + 界外匹配 → 不学习）")
} catch (e) { fail("有界读取", e) } finally { restore() }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
