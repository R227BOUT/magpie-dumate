// 第二十九轮：真实 agent 框架兼容性 —— 用 AI SDK 实际跑（而非模拟其调用形态）
// 验证 plugin 的 loader 输出在 @ai-sdk/openai-compatible 的 streamText/generateText 下端到端可用
//
// AI SDK 装在 magpie 的 workspace 里，且 ESM 不吃 NODE_PATH，所以按 SDK_ROOT
// 显式解析入口。位置不写死：优先 AI_SDK_ROOT，其次从用户目录推导，
// 两者都不成立就跳过——这条套件本来就不该因为换机器而红。
import { readFileSync, existsSync } from "node:fs"
import { createDecipheriv } from "node:crypto"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { DuMatePlugin } from "./index.mjs"

const SDK_ROOT = process.env.AI_SDK_ROOT
  ?? join(homedir(), ".workbuddy", "binaries", "node", "workspace", "node_modules")

// 存在性判断用 fs 直查，不经 require：避免 exports 条件差异带来的假阴性。
const sdkAvailable = existsSync(join(SDK_ROOT, "ai", "package.json"))
if (!sdkAvailable) {
  console.log(`  SKIP AI SDK 未安装（${SDK_ROOT}）——设 AI_SDK_ROOT 或跳过本套件`)
  process.exit(0)
}

// ESM 不吃 NODE_PATH。不能用 require.resolve(spec)：它会按 "require" 条件解析，
// zod 会落到 index.cjs（CJS 命名空间里取 z 很脆）。改为读包自己的 package.json，
// 显式取 "import" 条件入口，结果确定。
const entryOf = (spec) => {
  const pkgPath = join(SDK_ROOT, ...spec.split("/"), "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  const exp = pkg.exports
  let rel = null
  if (typeof exp === "string") rel = exp
  else if (exp && typeof exp === "object") {
    const dot = exp["."] ?? exp
    rel = typeof dot === "string" ? dot : (dot?.import ?? dot?.default ?? null)
  }
  rel ??= pkg.module ?? pkg.main
  if (!rel) throw new Error(`无法确定 ${spec} 的 ESM 入口`)
  return pathToFileURL(join(dirname(pkgPath), rel)).href
}
const importFromSdk = async (spec) => import(entryOf(spec))

const dir = join(process.env.APPDATA ?? "", "qianfan-desktop-app")
const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))
const key = readFileSync(join(dir, ".cookie-key"))
const buf = Buffer.from(auth.cookies, "base64")
const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
d.setAuthTag(buf.subarray(12, 28))
const cookies = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"))

const seat = { type: "oauth", cookies, source: "desktop" }
const hooks = await DuMatePlugin({})
const loader = await hooks.auth.loader(async () => seat)

// AI SDK 的 openai-compatible provider 需要 createOpenAICompatible 风格的 fetch
const { createOpenAICompatible } = await importFromSdk("@ai-sdk/openai-compatible")
const provider = createOpenAICompatible({
  name: "dumate",
  baseURL: "https://dumate-svc.baidu.com/gateway/apis/v1",
  apiKey: "dumate",
  fetch: loader.fetch,
})
const model = provider.chatModel("model-text")

const { generateText, streamText, tool, stepCountIs } = await importFromSdk("ai")
const { z } = await importFromSdk("zod")
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[SDK1] generateText 端到端")
try {
  const r = await generateText({ model, prompt: "只回复两个字：正常", maxOutputTokens: 256 })
  const text = r.text ?? ""
  if (!text) throw new Error("空 text（finish=" + r.finishReason + "）")
  ok(`generateText -> "${text.slice(0, 12)}" (finish=${r.finishReason})`)
} catch (e) { fail("generateText", e) }

console.log("[SDK2] streamText 端到端（textStream 逐块）")
try {
  const r = streamText({ model, prompt: "从一数到三，用中文顿号分隔", maxOutputTokens: 256 })
  let chunks = 0, text = ""
  for await (const delta of r.textStream) { chunks++; text += delta }
  if (!text) throw new Error("空流")
  ok(`streamText -> ${chunks} 块, "${text.slice(0, 20)}"`)
} catch (e) { fail("streamText", e) }

console.log("[SDK3] 多步工具调用（stopWhen: stepCountIs）—— agent 核心循环")
try {
  const r = await generateText({
    model,
    maxOutputTokens: 1024,
    prompt: "用计算器工具计算 12*34，然后把结果告诉我。",
    tools: {
      calc: tool({
        description: "计算数学表达式",
        inputSchema: z.object({ expr: z.string() }),
        execute: async ({ expr }) => {
          if (expr.includes("12*34")) return "408"
          return "未知表达式"
        },
      }),
    },
    stopWhen: stepCountIs(5),
  })
  const hasCall = r.steps.some((s) => s.toolCalls?.length)
  if (!hasCall) throw new Error("未发起工具调用")
  if (!r.text.includes("408")) throw new Error("最终回答未含工具结果: " + r.text.slice(0, 80))
  ok(`多步 agent 循环：${r.steps.length} 步，回答含 408`)
} catch (e) { fail("多步工具", e) }

console.log("[SDK4] system prompt + 多消息数组")
try {
  const r = await generateText({
    model,
    maxOutputTokens: 512,
    system: "你只能回复：收到",
    messages: [{ role: "user", content: "测试" }],
  })
  if (!r.text.includes("收到")) throw new Error("system 未生效: " + r.text.slice(0, 30))
  ok(`system 消息生效（"${r.text.slice(0, 10)}"）`)
} catch (e) { fail("system", e) }

console.log("[SDK5] usage 计量（AI SDK 口径）")
try {
  const r = await generateText({ model, prompt: "回复ok", maxOutputTokens: 256 })
  const u = r.usage
  if (!u || (!u.inputTokens && !u.inputTokensDetails)) throw new Error("usage 缺失: " + JSON.stringify(u ?? {}).slice(0, 100))
  ok(`usage: input=${u.inputTokens ?? "?"} output=${u.outputTokens ?? "?"}`)
} catch (e) { fail("usage", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
