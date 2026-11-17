// v0.5.0 请求侧预算与模型路由助手（从 dumate2api 的实测结论移植并复核修订，
// 参考 wearetheone777/dumate2api 的 src/budget.js / src/dumate-caps.js /
// src/modelmap.js / src/dumate-reasoning.js，按 Magpie 插件的定位裁剪）。
//
// 三条职责，全部只作用于「已解析为对象的聊天请求体」：
//   1. routeModel      —— 模型名路由：可信清单直通；[1M] 只剥后缀；
//                         glm-5→glm-53 是「版本替代」映射（出站改名 + 诊断）；
//                         未知模型返回 null（调用方显式拒绝，绝不静默兜底）。
//   2. applyBudget     —— max_tokens 钳制：floor 抬升只对 FLOOR_ENABLED 里的
//                         模型启用（第一阶段仅 deepseek-v41-flash，实测其长推理
//                         任务在小预算下会出现「思考耗尽、正文 0」）；其余模型
//                         维持既有显式预算行为，只做保护性 cap 钳制；
//                         MAGPIE_DUMATE_BUDGET=off 整体关闭抬升（原始透传退出路径）。
//   3. 上限学习         —— 只从官方网关 400 的 max_tokens 范围错误里学习，
//                         按归一后模型键存储，TTL 7 天，原子写 0600/0700，
//                         损坏容错；本版本不自动重试。
//
// 上限优先级：学习值 > 已验证静态上限（OUTPUT_CAPS）> 未知默认（DEFAULT_CAP）。
// 注意 OUTPUT_CAPS 里 text.L1 的 2000000 是「实测可接受值」，不是已探明硬上限，
// 文档不得宣称上游硬上限。cap < floor 时以 cap 为准（绝不越上游限制凑下限）。

import { mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { SNAPSHOT_DIR_NAME } from "./models.mjs"

// dumate2api 实测：通道全局可接受的上限缺省（超过会被上游拒绝）。
export const DEFAULT_CAP = 131072
// dumate2api 实测：低于此值的长推理任务会出现 reasoning 吃满预算、正文为 0。
export const FLOOR = 65536
export const DEFAULT_BUDGET = 32768

export const CAPS_TTL_MS = 7 * 24 * 3600e3
// 400 错误体的分析窗（有界读取承诺：窗外的匹配不学习）。
export const LEARN_SLICE = 8192
// 学习读取的总量上界：无论声明与否，实际经过的字节超过此值即放弃学习。
export const LEARN_READ_CAP = 65536

// 400 上限学习的流式旁路观察（GPT-REVIEW-V050-R3 最终方案）：
// 原始分块经 TransformStream **零改动直通下游**（无复制、无暂存、无重编码——
// 非法 UTF-8 也逐字节保真）；旁路只缓存前 LEARN_SLICE 字节作为学习样本，并按
// 实际字节数统计整个响应体，总量超过 LEARN_READ_CAP 即清空样本放弃学习。
// 学习写入只发生在下游**完整消费**之后（transform 流的 flush；下游中途取消
// 则 flush 不执行，本次学习自然放弃）。不使用 Response.clone()，无预读取阻塞，
// 单个超大分块也不会为学习而入缓冲区（旁路最多切取 sampleCap 字节）。
export function tapLearningStream(res, { onLearn, readCap = LEARN_READ_CAP, sampleCap = LEARN_SLICE } = {}) {
  let sample = []
  let sampleBytes = 0
  let total = 0
  let overflow = false
  return res.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      // 原始字节原样交给下游——学习侧永不改写响应。
      controller.enqueue(chunk)
      const size = chunk?.byteLength ?? 0
      total += size
      if (total > readCap) {
        overflow = true
        sample = []
        sampleBytes = 0
        return
      }
      if (sampleBytes < sampleCap) {
        const room = sampleCap - sampleBytes
        const slice = size <= room ? chunk : chunk.subarray(0, room)
        sample.push(slice)
        sampleBytes += slice.byteLength
      }
    },
    flush() {
      if (overflow || !sampleBytes || !onLearn) return
      try {
        const text = new TextDecoder().decode(Buffer.concat(sample))
        const cap = learnCapFromBody(text)
        if (cap) onLearn(cap)
      } catch {
        // 样本损坏/解码失败——学习是非关键旁路，静默放弃。
      }
    },
  }))
}

// 已验证静态上限（dumate2api src/dumate-caps.js 的实测值）。
export const OUTPUT_CAPS = {
  "model-text": 393216,
  "dm-auto-model/text.L0": 393216,
  "dm-auto-model/mm.L0": 393216,
  "dm-auto-model/mm.L2": 393216,
  "dm-auto-model/text.L1": 2000000, // 实测可接受值，非已探明硬上限
  "dm-auto-model/text.L2": 131072,
}

// floor 抬升白名单：第一阶段仅 deepseek-v41-flash（有实测依据的模型）。
// 扩围必须先走真实数据验收（与 reasoning.mjs 的白名单纪律一致）。
export const FLOOR_ENABLED = new Set(["deepseek-v41-flash"])

// 版本替代映射（不是同一模型，不宣称同一模型）：glm-5 在桌面链路对应
// GLM-5.2 的别名，云端路由下实际由 GLM-5.3 档提供服务。出站改名并在
// X-Magpie-Dumate-Route 响应头记录 original=>outbound。
export const MODEL_REPLACEMENTS = { "glm-5": "glm-53" }

// ---- 模型名路由 -------------------------------------------------------------

const validName = (s) => typeof s === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(s)

// 返回 { outbound, note }；未知/空名返回 null（调用方显式 400）。
// note: null=直通；"replacement"=版本替代；"suffix"=仅剥了 [1M] 后缀。
//
// trusted 是 Map：键 = 归一化查找键（小写），值 = 可信清单记录的**规范 API ID**。
// 匹配键与出站键分离（GPT-REVIEW-V050-R1 任务一）：查找允许大小写归一，
// 但出站一律采用清单记录的原始规范 ID——dm-auto-model/text.L0 不得变成
// text.l0（云端是否接受小写无证据，不得视为等价）。
export function routeModel(name, trusted) {
  const raw = typeof name === "string" ? name.trim() : ""
  if (!raw) return null
  // [1M] 只是上下文窗口的命名标记，剥掉后不据此宣称 1M 上下文。
  const hadSuffix = /\[1M\]$/i.test(raw)
  const stripped = raw.replace(/\[1M\]$/i, "").trim()
  if (!validName(stripped)) return null
  const key = stripped.toLowerCase()
  const replacement = MODEL_REPLACEMENTS[key]
  if (replacement) return { outbound: replacement, note: "replacement" }
  const canonical = trusted instanceof Map ? trusted.get(key) : null
  if (!canonical) return null
  return { outbound: canonical, note: hadSuffix ? "suffix" : null }
}

// ---- max_tokens 预算 --------------------------------------------------------

const validBudget = (n) => Number.isSafeInteger(n) && n > 0

// floor=defaultBudget=cap 的语义见 README「预算钳制」；cap 传 null 表示不钳。
export function resolveMaxTokens(requested, { floor = 0, defaultBudget = DEFAULT_BUDGET, cap = null } = {}) {
  let out = validBudget(requested) ? requested : defaultBudget
  if (floor > 0) out = Math.max(out, floor)
  if (cap != null) out = Math.min(out, cap)
  return out
}

// ---- 上限查找（键与出站 ID 统一规则：精确命中优先，等价大小写次之） ----------

// OUTPUT_CAPS 的键是规范 API ID（含大写 L）；查找必须大小写一致，
// 否则 dm-auto-model/text.L1 会错落 131072 默认值而漏掉 2000000 专属上限
// （GPT-REVIEW-V050-R1 任务二）。
function lookupStaticCap(model) {
  const direct = OUTPUT_CAPS[model]
  if (Number.isSafeInteger(direct)) return direct
  const lower = model.toLowerCase()
  for (const [key, value] of Object.entries(OUTPUT_CAPS)) {
    if (key.toLowerCase() === lower && Number.isSafeInteger(value)) return value
  }
  return undefined
}

// 学习缓存按出站模型键存储（规范形态）；查找同样大小写一致。
function lookupLearnedCap(caps, model) {
  const hit = caps?.[model]
  if (Number.isSafeInteger(hit?.cap) && hit.cap > 0) return hit.cap
  const lower = model.toLowerCase()
  for (const [key, value] of Object.entries(caps ?? {})) {
    if (key.toLowerCase() === lower && Number.isSafeInteger(value?.cap) && value.cap > 0) return value.cap
  }
  return undefined
}

// 原地修改 request.max_tokens 并返回 request。
// floor 只对 FLOOR_ENABLED 启用；其余模型缺省不注入、显式值只做保护性钳制。
// MAGPIE_DUMATE_BUDGET=off 关闭抬升（缺省不注入、显式值原样）。
export function applyBudget(request, { env = process.env, caps = {} } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return request
  const model = typeof request.model === "string" ? request.model : ""
  if (!model) return request
  const liftOff = String(env?.MAGPIE_DUMATE_BUDGET ?? "").trim().toLowerCase() === "off"
  const cap = lookupLearnedCap(caps, model) ?? lookupStaticCap(model) ?? DEFAULT_CAP
  if (!liftOff && FLOOR_ENABLED.has(model.toLowerCase())) {
    request.max_tokens = resolveMaxTokens(request.max_tokens, { floor: FLOOR, defaultBudget: DEFAULT_BUDGET, cap })
    return request
  }
  // 非白名单模型：维持既有显式预算行为（缺省不注入），显式合法值只向下钳。
  if (validBudget(request.max_tokens)) request.max_tokens = Math.min(request.max_tokens, cap)
  return request
}

// ---- 上限学习 ----------------------------------------------------------------

// 只识别官方网关 400 里 max_tokens 范围类错误；分析窗 LEARN_SLICE 字节内。
export function learnCapFromBody(text) {
  const slice = String(text ?? "").slice(0, LEARN_SLICE)
  const patterns = [
    /max_tokens[^0-9]{0,60}?1\s*,\s*(\d+)/i,            // qianfan: max_tokens range is [1, 4096]
    /max_tokens[^0-9]{0,40}超过\s*(\d+)/,                  // GLM 中文：max_tokens 不能超过 8192
    /range of max_tokens[^0-9]{0,40}\d+\s*(?:to|至|~|-)\s*(\d+)/i, // Range of max_tokens is 1 to N
  ]
  for (const re of patterns) {
    const m = slice.match(re)
    if (!m) continue
    const cap = Number(m[1])
    if (validBudget(cap)) return cap
  }
  return null
}

// 与 models.mjs 的快照同目录同纪律：stateDir 优先，缺省回落 magpie 配置根。
export function capsPath({ stateDir, env = process.env } = {}) {
  const store = join(stateDir || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie"), SNAPSHOT_DIR_NAME)
  return join(store, "caps.json")
}

function readCapsFile(path) {
  const st = statSync(path)
  if (!st.isFile() || st.size <= 0 || st.size > 64 * 1024) throw new Error("Invalid caps file size")
  return JSON.parse(readFileSync(path, "utf8"))
}

// 读取并校验上限缓存：TTL 过期、非法数值、坏键名一律丢弃；损坏返回空表。
export function loadCaps(path, now = Date.now()) {
  let parsed
  try {
    parsed = readCapsFile(path)
  } catch {
    return {}
  }
  if (parsed?.schema !== 1 || !parsed.caps || typeof parsed.caps !== "object" || Array.isArray(parsed.caps)) return {}
  const out = Object.create(null)
  for (const [key, entry] of Object.entries(parsed.caps)) {
    if (!validName(key) || !entry || typeof entry !== "object") continue
    const { cap, at } = entry
    if (!validBudget(cap) || !Number.isFinite(at) || at <= 0 || now - at > CAPS_TTL_MS) continue
    out[key] = { cap, at }
  }
  return out
}

// 原子写单个学习结果：合并既有条目（各自保留原时间戳），临时文件 + rename。
// 写盘失败向上抛（调用方必须降级，不得影响本次网关响应）。
export function saveCap(path, model, cap, now = Date.now()) {
  if (!validName(model) || !validBudget(cap)) throw new Error("Invalid cap learning input")
  let caps = {}
  try {
    const parsed = readCapsFile(path)
    if (parsed?.schema === 1 && parsed.caps && typeof parsed.caps === "object" && !Array.isArray(parsed.caps)) {
      caps = parsed.caps
    }
  } catch {
    // 损坏/不存在 → 从空表开始（自愈）。
  }
  caps[model] = { cap, at: now }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ schema: 1, caps }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    renameSync(temp, path)
  } finally {
    try { unlinkSync(temp) } catch {
      // rename 成功（或临时文件从未落盘）——无需清理。
    }
  }
}
