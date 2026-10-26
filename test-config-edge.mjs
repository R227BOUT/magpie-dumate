// 第七轮补充：模型清单冷启动竞态 —— magpie 拉模型表发生在登录之前/之后的两种时序
// 用真实插件实例 + fetch mock 模拟"models hook 被调用时 seat 刚好还没写入"的场景
import { DuMatePlugin } from "./index.mjs"

const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const hooks = await DuMatePlugin({})

console.log("[N1] provider.models 收标准 config（含 models 表）正常返回")
try {
  // raccoon 对照实测：models(undefined) 同样抛错 —— magpie 实际调用时 config.models 必在。
  // 正确契约 = 收 config 对象、返回 config.models。
  const cfg = { models: [{ id: "model-text", name: "X" }] }
  const r = await hooks.provider.models(cfg)
  if (!Array.isArray(r) || r[0].id !== "model-text") throw new Error("返回不对: " + JSON.stringify(r).slice(0, 100))
  ok("标准 config -> 返回 models 表")
} catch (e) { fail("models(config)", e) }

console.log("[N2] provider.models 原样透传（不被篡改/排序/去重）")
try {
  const custom = { models: [{ id: "my-model", name: "My Model" }] }
  const r = await hooks.provider.models(custom)
  if (JSON.stringify(r) !== JSON.stringify(custom.models)) throw new Error("被篡改: " + JSON.stringify(r))
  ok("自定义模型表原样透传")
} catch (e) { fail("models(custom)", e) }

console.log("[N3] config hook 重复调用幂等（不叠模型）")
try {
  const config = {}
  await hooks.config(config)
  const before = Object.keys(config.provider.dumate.models).length
  await hooks.config(config)
  await hooks.config(config)
  const after = Object.keys(config.provider.dumate.models).length
  if (before !== after) throw new Error(`重复调用后模型数变化 ${before} -> ${after}`)
  ok(`三次调用模型数恒定（${after} 个）`)
} catch (e) { fail("config 幂等", e) }

console.log("[N4] config hook 不覆盖用户已自定义的字段")
try {
  const config = { provider: { dumate: { name: "我的搭子", npm: "custom-pkg", models: { "my-model": { name: "M" } } } } }
  await hooks.config(config)
  const p = config.provider.dumate
  if (p.name !== "我的搭子") throw new Error("name 被覆盖: " + p.name)
  if (p.npm !== "custom-pkg") throw new Error("npm 被覆盖: " + p.npm)
  if (!p.models["my-model"]) throw new Error("自定义模型被清掉")
  if (!p.models["model-text"]) throw new Error("fallback 模型没补上")
  ok("用户自定义（name/npm/模型）全保留 + fallback 只补缺")
} catch (e) { fail("config 合并语义", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
