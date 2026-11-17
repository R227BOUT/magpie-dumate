// 第三十四轮：真实模型清单导入 / 快照独立性 / V4.1 推理档位
// 方案来自 RanceLee（公众号 HelloRanceLee, 2026-11-13）。全部离线。
// 重点：只导元数据，源文件删掉后模型不清空，凭据类字段一个都不许过墙。
import { importModels, loadModels, SNAPSHOT_DIR_NAME } from "./models.mjs"
import { normalizeReasoningBody } from "./reasoning.mjs"
import { DuMatePlugin } from "./index.mjs"
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }
const dir = join(tmpdir(), "dumate-catalog-test")
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const sourcePath = join(dir, "opencode.json")
const snapshotPath = join(dir, SNAPSHOT_DIR_NAME, "models.snapshot.json")

const model = (id, extra = {}) => ({
  id,
  name: id,
  limit: { context: 200000, output: 32000 },
  modalities: { input: ["text"], output: ["text"] },
  ...extra,
})

function sourceConfig(models) {
  // 这些是 DuMate 源文件里真实会出现的字段，一个都不许被导入。
  return {
    provider: {
      QianfanPersonalQuota: {
        npm: "@ai-sdk/openai-compatible",
        name: "QianfanPersonalQuota",
        options: { apiKey: "PLACEHOLDER-NOT-A-SECRET", baseURL: "http://127.0.0.1:1/v1", headers: { "X-Test": "1" } },
        plugins: ["should-not-be-imported"],
        permission: { edit: "allow" },
        models,
      },
    },
  }
}

console.log("[C1] 只导元数据：apiKey / headers / plugins / 本地代理地址全部丢弃")
try {
  const src = sourceConfig({ "model-text": model("model-text") })
  const { models } = importModels(src)
  const text = JSON.stringify(models)
  for (const bad of ["PLACEHOLDER-NOT-A-SECRET", "127.0.0.1", "should-not-be-imported", "apiKey", "headers", "permission", "baseURL"]) {
    if (text.includes(bad)) throw new Error(`输出里混入了 ${bad}`)
  }
  if (!models["model-text"] || models["model-text"].id !== "model-text") throw new Error("正常条目没导入")
  ok("仅 id/name/limit/tool_call/reasoning/attachment/modalities")
} catch (e) { fail("元数据隔离", e) }

console.log("[C2] 排除内部任务 / mock / OCR / 向量 / 重排 / 文生图入口")
try {
  const src = sourceConfig({
    "model-text": model("model-text"),
    "model-artifact-validate": model("model-artifact-validate"),
    "llm-mock": model("llm-mock"),
    "dumate-image-x": model("dumate-image-x"),
    "text-embedding-v1": model("text-embedding-v1"),
    "bce-reranker": model("bce-reranker"),
    "ocr-helper": model("ocr-helper"),
  })
  const { models, excluded } = importModels(src)
  if (Object.keys(models).length !== 1 || !models["model-text"]) throw new Error("过滤不干净: " + Object.keys(models).join(","))
  if (excluded < 6) throw new Error("排除计数异常: " + excluded)
  ok(`保留 1 个对话入口，排除 ${excluded} 个非对话入口`)
} catch (e) { fail("内部入口过滤", e) }

console.log("[C3] 别名与实际 API id 分开，重复别名去重")
try {
  // glm-5 只是 model-text 的别名：真实 DuMate 配置里就有这种写法
  const aliased = importModels(sourceConfig({ "glm-5": model("model-text") })).models
  if (!aliased["glm-5"] || !aliased["glm-5"].name.includes("API: model-text")) throw new Error("别名未标注真实 id")
  const dup = importModels(sourceConfig({
    "model-text": model("model-text"),
    "glm-5": model("model-text"),
  })).models
  if (dup["glm-5"]) throw new Error("已有真实条目时别名未被去重")
  ok("别名显示真实 API id，重复别名不生成第二个入口")
} catch (e) { fail("别名处理", e) }

console.log("[C4] 无效 limit / 非文本输入被跳过")
try {
  const src = sourceConfig({
    zero: model("zero", { limit: { context: 0, output: 10 } }),
    negative: model("negative", { limit: { context: -1, output: 10 } }),
    stringy: model("stringy", { limit: { context: "200000", output: 10 } }),
    imageOnly: model("imageOnly", { modalities: { input: ["image"], output: ["text"] } }),
    good: model("good", { limit: { input: 128000, output: 8000 } }),
  })
  const { models } = importModels(src)
  if (Object.keys(models).length !== 1 || !models.good) throw new Error("边界过滤失败: " + Object.keys(models).join(","))
  if (models.good.limit.context !== 128000) throw new Error("limit.input 回落未生效")
  ok("仅保留有效条目，context 可由 limit.input 回落")
} catch (e) { fail("字段校验", e) }

console.log("[C5] V4.1 的 1M 窗口与多模态、四档推理变体")
try {
  const { models } = importModels(sourceConfig({
    "deepseek-v41-flash": model("deepseek-v41-flash", {
      limit: { context: 1000000, output: 384000 },
      modalities: { input: ["text", "image", "bogus"], output: ["text"] },
    }),
  }))
  const m = models["deepseek-v41-flash"]
  if (m.limit.context !== 1000000 || m.limit.output !== 384000) throw new Error("窗口/输出上限丢失")
  if (!m.attachment || m.modalities.input.includes("bogus")) throw new Error("模态处理错误")
  if (!m.reasoning || Object.keys(m.variants ?? {}).join(",") !== "none,low,high,max") throw new Error("四档变体缺失")
  ok("1000000/384000 + 图像输入 + none/low/high/max")
} catch (e) { fail("V4.1 元数据", e) }

console.log("[C6] 首次导入写出独立快照，内容不含凭据与本机路径")
try {
  writeFileSync(sourcePath, JSON.stringify(sourceConfig({
    "model-text": model("model-text"),
    "deepseek-v41-flash": model("deepseek-v41-flash", { limit: { context: 1000000, output: 384000 } }),
  })))
  const got = loadModels({ sourcePath, stateDir: dir })
  if (!got["model-text"] || !got["deepseek-v41-flash"]) throw new Error("导入结果不完整")
  if (!existsSync(snapshotPath)) throw new Error("快照未写出")
  const raw = readFileSync(snapshotPath, "utf8")
  for (const bad of ["PLACEHOLDER-NOT-A-SECRET", "127.0.0.1", "should-not-be-imported", "apiKey", "opencode.json", dir]) {
    if (raw.includes(bad)) throw new Error(`快照里含 ${bad}`)
  }
  ok("快照为纯模型元数据，无 endpoint / key / 路径")
} catch (e) { fail("快照写入", e) }

console.log("[C7] 源文件删除后仍能从快照加载（卸载 DuMate 不清空模型）")
try {
  rmSync(sourcePath)
  const got = loadModels({ sourcePath, stateDir: dir })
  if (!got["model-text"] || !got["deepseek-v41-flash"]) throw new Error("源文件缺失后模型被清空")
  ok("快照回退生效")
} catch (e) { fail("快照回退", e) }

console.log("[C8] 快照损坏时回退包内参考清单，且不是空")
try {
  writeFileSync(snapshotPath, "not-json")
  const got = loadModels({ sourcePath, stateDir: dir })
  const n = Object.keys(got).length
  if (n < 10) throw new Error("参考清单未生效，只得到 " + n + " 个")
  ok(`回退到包内参考清单（${n} 个）`)
} catch (e) { fail("参考清单回退", e) }

console.log("[C9] 快照也要过同一把过滤器（被塞入 apiKey 不会进 config）")
try {
  writeFileSync(snapshotPath, JSON.stringify({
    schema: 1,
    models: {
      "model-text": { id: "model-text", limit: { context: 192000, output: 128000 }, modalities: { input: ["text"] }, apiKey: "INJECTED" },
      evil: { id: "evil", limit: { context: 1, output: 1 }, modalities: { input: ["text"] } },
    },
  }))
  const got = loadModels({ sourcePath, stateDir: dir })
  if (JSON.stringify(got).includes("INJECTED")) throw new Error("快照里的额外字段被带出")
  ok("快照重新过 importModels，只留元数据")
} catch (e) { fail("快照再校验", e) }

console.log("[C10] config hook 保留用户手动添加的模型与自定义设置")
try {
  const plugin = await DuMatePlugin({ directory: dir })
  const config = { provider: { dumate: { models: { "my-custom": { name: "我加的", limit: { context: 4096, output: 512 } } } } } }
  await plugin.config(config)
  const m = config.provider.dumate.models
  if (!m["model-text"] || !m["my-custom"]) throw new Error("fallback 或用户模型丢失")
  if (m["my-custom"].name !== "我加的") throw new Error("用户自定义设置被覆盖")
  ok(`共 ${Object.keys(m).length} 个入口，用户条目原样保留`)
} catch (e) { fail("config 合并", e) }

console.log("[C11] V4.1 推理档位：none 显式关闭，low 归一为 high")
try {
  const base = (effort) => JSON.stringify({ model: "deepseek-v41-flash", reasoning_effort: effort, messages: [] })
  const none = JSON.parse(normalizeReasoningBody(base("none")))
  if (none.reasoning_effort !== undefined || none.thinking.type !== "disabled" || none.enable_thinking !== false) {
    throw new Error("none 未彻底关闭思考")
  }
  const low = JSON.parse(normalizeReasoningBody(base("low")))
  if (low.reasoning_effort !== "high" || low.thinking.type !== "enabled" || low.enable_thinking !== true) throw new Error("low 映射错误")
  for (const lv of ["high", "max"]) {
    const r = JSON.parse(normalizeReasoningBody(base(lv)))
    if (r.reasoning_effort !== lv || r.enable_thinking !== true) throw new Error(lv + " 被改写")
  }
  const other = base("none").replace("deepseek-v41-flash", "kimi-k3")
  if (normalizeReasoningBody(other) !== other) throw new Error("白名单外模型被改写")
  if (normalizeReasoningBody("not-json") !== "not-json") throw new Error("非 JSON 被改写")
  ok("四档映射正确，白名单外模型与非 JSON 请求不受影响")
} catch (e) { fail("推理档位", e) }

console.log("[C12] 重定向策略：不跟随但保留 3xx，坏凭据仍能判为登录失效")
try {
  const src = readFileSync(new URL("./index.mjs", import.meta.url), "utf8")
  const manual = (src.match(/redirect:\s*"manual"/g) ?? []).length
  if (manual !== 3) throw new Error(`应有 3 处 manual 重定向，实际 ${manual}`)
  if (/redirect:\s*"error"/.test(src)) throw new Error("仍存在硬拒绝重定向（会把 401 降级成 502）")
  const checks = (src.match(/res\.status >= 300 && res\.status < 400/g) ?? []).length
  if (checks !== 3) throw new Error(`3xx 判定应覆盖 console×2 + 聊天×1，实际 ${checks}`)
  ok("3 处 manual + 3 处 3xx 判定，安全与错误语义兼顾")
} catch (e) { fail("重定向策略", e) }

// 0.4.0 推理档位：magpie 宿主把用户选的档位放在 X-Magpie-Effort 请求头里
// 传给插件的 fetch（正文不写），所以 normalizeReasoningBody 增加第二个参数：头部档位兜底。
//
// 白名单只有 deepseek-v41-flash —— 2026-11-17 对本机真实网关逐模型对照实测后，
// 其他候选全部被证据否决（见 README「推理档位」）：
//   glm-53：默认 rt=276，带 reasoning_effort 后 rt=0 —— 参数等于"关思考"，声明档位有害
//   model-text / dm-auto-model/text.L0：plain/low/high 差异在生成长度噪声内，方向不稳定
//   kimi-k3：首测 low<high，复测 low>high —— 噪声，不是档位
//   deepseek-v4-pro：两次重复 high≤low —— 无分级证据
//   qwen4-max：纯请求即 400（上游缺必需头），与本插件无关
console.log("[C13] 白名单外模型带头部档位时请求一个字节都不改写")
try {
  for (const model of ["glm-53", "model-text", "dm-auto-model/text.L0", "kimi-k3"]) {
    const body = JSON.stringify({ model, messages: [] })
    for (const lv of ["none", "low", "medium", "high", "xhigh"]) {
      if (normalizeReasoningBody(body, lv) !== body) {
        throw new Error(`${model} 被头部档位 ${lv} 改写了（实测不支持分级，必须保持原样）`)
      }
    }
  }
  ok("glm-53/model-text/text.L0/kimi-k3 全部原样通过")
} catch (e) { fail("白名单外零改动", e) }

console.log("[C14] 正文档位归一并优先于头部档位")
try {
  const body = JSON.stringify({ model: "deepseek-v41-flash", reasoning_effort: "xhigh", messages: [] })
  const r = JSON.parse(normalizeReasoningBody(body, "low"))
  if (r.reasoning_effort !== "high") throw new Error(`正文档位应归一为 high，得到 ${r.reasoning_effort}`)
  ok("正文 xhigh 归一 high（未被头部 low 覆盖）")
} catch (e) { fail("正文档位优先", e) }

console.log("[C15] deepseek-v41-flash 头部档位走既有开关联映射")
try {
  const noEffort = () => JSON.stringify({ model: "deepseek-v41-flash", messages: [] })
  const low = JSON.parse(normalizeReasoningBody(noEffort(), "low"))
  if (low.reasoning_effort !== "high" || low.thinking?.type !== "enabled" || low.enable_thinking !== true) {
    throw new Error("头部 low 未映射到 high+开")
  }
  const medium = JSON.parse(normalizeReasoningBody(noEffort(), "medium"))
  if (medium.reasoning_effort !== "high") throw new Error("头部 medium 应归一为 high")
  const max = JSON.parse(normalizeReasoningBody(noEffort(), "max"))
  if (max.reasoning_effort !== "max" || max.enable_thinking !== true) throw new Error("头部 max 未保留")
  const none = JSON.parse(normalizeReasoningBody(noEffort(), "none"))
  if ("reasoning_effort" in none || none.thinking?.type !== "disabled" || none.enable_thinking !== false) {
    throw new Error("头部 none 未彻底关闭思考")
  }
  ok("deepseek-v41-flash：low/medium→high、max 保留、none 关闭")
} catch (e) { fail("头部档位 deepseek", e) }

console.log("[C16] 无档位、非法头部值、非字符串档位一律不触碰请求")
try {
  const bare = JSON.stringify({ model: "deepseek-v41-flash", messages: [] })
  if (normalizeReasoningBody(bare) !== bare) throw new Error("无档位被改写")
  if (normalizeReasoningBody(bare, "bogus") !== bare) throw new Error("非法头部值被改写")
  if (normalizeReasoningBody(bare, "  ") !== bare) throw new Error("空白头部值被改写")
  if (normalizeReasoningBody(bare, 42) !== bare) throw new Error("非字符串头部值被改写")
  ok("无/非法档位均原样通过")
} catch (e) { fail("边界不触碰", e) }

console.log("[C17] 推理元数据只给实证模型：仅 deepseek-v41-flash 带档位")
try {
  const { models } = importModels(sourceConfig({
    "deepseek-v41-flash": model("deepseek-v41-flash"),
    "glm-53": model("glm-53"),
    "model-text": model("model-text"),
    "dm-auto-model/text.L0": model("dm-auto-model/text.L0"),
    "kimi-k3": model("kimi-k3"),
    "qwen4-max": model("qwen4-max"),
  }))
  const ds = models["deepseek-v41-flash"]
  if (!ds?.reasoning) throw new Error("deepseek 未声明 reasoning")
  if (Object.keys(ds.variants ?? {}).join(",") !== "none,low,high,max") {
    throw new Error("deepseek variants 应为 none/low/high/max，得到 " + Object.keys(ds.variants ?? {}).join(","))
  }
  for (const id of ["glm-53", "model-text", "dm-auto-model/text.L0", "kimi-k3", "qwen4-max"]) {
    if (models[id]?.reasoning) throw new Error(`${id} 实测无分级控制，不应声明 reasoning`)
    if (models[id]?.variants) throw new Error(`${id} 不应声明 variants`)
  }
  ok("只有 deepseek 带四档；glm/model-text/L0/kimi/qwen 全部保持沉默")
} catch (e) { fail("推理白名单元数据", e) }

console.log("[C18] 固定回退表不声明档位（未实测的模型不暴露死档位）")
try {
  const plugin = await DuMatePlugin({ directory: dir })
  const config = { provider: {} }
  await plugin.config(config)
  const m = config.provider.dumate.models
  for (const id of ["model-text", "dm-auto-model/text.L0"]) {
    if (m[id]?.variants) throw new Error(`回退表 ${id} 不应声明 variants（上游无分级控制）`)
  }
  ok("回退表两个入口均无 variants")
} catch (e) { fail("回退表档位", e) }

console.log("[C19] 白名单单一事实源：models.mjs 必须从 reasoning.mjs 取，不得自带副本")
try {
  const modelsSrc = readFileSync(new URL("./models.mjs", import.meta.url), "utf8")
  const reasoningSrc = readFileSync(new URL("./reasoning.mjs", import.meta.url), "utf8")
  // CR-001：两处各写一份白名单会静默漂移（UI 出现档位但请求不改写）。
  // 哨兵只禁「第二份白名单定义」：模型名本身在过滤逻辑/注释里出现是合法的。
  if (!/from\s+"\.\/reasoning\.mjs"/.test(modelsSrc)) {
    throw new Error("models.mjs 未从 reasoning.mjs 引入白名单（单一事实源被破坏）")
  }
  if (/const\s+(REASONING_MODELS|VARIANTS_\w+)/.test(modelsSrc)) {
    throw new Error("models.mjs 又定义了一份白名单/variants 常量（CR-001 复发）")
  }
  if (!/export const REASONING\b/.test(reasoningSrc)) {
    throw new Error("reasoning.mjs 未导出 REASONING 白名单表")
  }
  ok("models.mjs 只消费 reasoning.mjs 的 REASONING 表，无第二份定义")
} catch (e) { fail("白名单单一事实源", e) }

rmSync(dir, { recursive: true, force: true })
console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
