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
export function routeModel(name, trusted) {
  const raw = typeof name === "string" ? name.trim() : ""
  if (!raw) return null
  // [1M] 只是上下文窗口的命名标记，剥掉后不据此宣称 1M 上下文。
  const hadSuffix = /\[1M\]$/i.test(raw)
  const stripped = raw.replace(/\[1M\]$/i, "").trim()
  if (!validName(stripped)) return null
  const lower = stripped.toLowerCase()
  const replacement = MODEL_REPLACEMENTS[lower]
  if (replacement) return { outbound: replacement, note: "replacement" }
  if (trusted instanceof Set && trusted.has(lower)) {
    return { outbound: lower, note: hadSuffix && lower !== raw ? "suffix" : null }
  }
  return null
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

// 原地修改 request.max_tokens 并返回 request。
// floor 只对 FLOOR_ENABLED 启用；其余模型缺省不注入、显式值只做保护性钳制。
// MAGPIE_DUMATE_BUDGET=off 关闭抬升（缺省不注入、显式值原样）。
export function applyBudget(request, { env = process.env, caps = {} } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return request
  const model = typeof request.model === "string" ? request.model.toLowerCase() : ""
  if (!model) return request
  const liftOff = String(env?.MAGPIE_DUMATE_BUDGET ?? "").trim().toLowerCase() === "off"
  const cap = caps[model]?.cap ?? OUTPUT_CAPS[model] ?? DEFAULT_CAP
  if (!liftOff && FLOOR_ENABLED.has(model)) {
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
