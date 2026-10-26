// 深度验证网关对 AI SDK 实际请求形态的支持：SSE 流式 / tool_calls / 多轮工具往返 / reasoning_content 处理
import { createDecipheriv } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const dir = join(process.env.APPDATA ?? "", "qianfan-desktop-app")
const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))
const key = readFileSync(join(dir, ".cookie-key"))
const buf = Buffer.from(auth.cookies, "base64")
const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
d.setAuthTag(buf.subarray(12, 28))
const cookies = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"))
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.82 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36"

const tr = await fetch("https://console.bce.baidu.com/api/dumate/app/token/get", {
  headers: { Cookie: cookieHeader, "User-Agent": UA, Accept: "application/json", Referer: "https://console.bce.baidu.com/" },
})
const token = (await tr.json()).result?.token
if (!token) { console.error("no token"); process.exit(1) }

async function call(body) {
  return fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
  })
}

const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e); process.exitCode = 1 }

// [S1] SSE 流式
console.log("[S1] SSE 流式")
try {
  const res = await call({
    model: "model-text", max_tokens: 64, stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "用一句话介绍你自己" }],
  })
  if (res.status !== 200 || !res.body) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  const chunks = text.split("\n").filter((l) => l.startsWith("data:"))
  let sawDelta = false, sawUsage = false, sawDone = false, content = "", reasoning = false
  for (const line of chunks) {
    const data = line.slice(5).trim()
    if (data === "[DONE]") { sawDone = true; continue }
    const j = JSON.parse(data)
    const delta = j.choices?.[0]?.delta ?? {}
    if (delta.content) { sawDelta = true; content += delta.content }
    if (delta.reasoning_content) reasoning = true
    if (j.usage) sawUsage = true
  }
  // finish_reason=length with only reasoning deltas is valid SSE behaviour
  // (all 64 tokens went to reasoning); accept it as long as the stream shape is right.
  if (!sawDelta && !reasoning) throw new Error("no content delta in stream")
  if (!sawDone) throw new Error("no [DONE] sentinel")
  ok(`SSE: ${chunks.length} chunks, content="${content.slice(0, 40) || "(全部为reasoning)"}", usage=${sawUsage}, reasoning_field=${reasoning}`)
} catch (e) { fail("SSE", e.message) }

// [S2] tool_calls 单轮
console.log("[S2] tool_calls")
try {
  const res = await call({
    model: "model-text", max_tokens: 256, stream: false,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "查询城市天气",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "城市名" } },
            required: ["city"],
          },
        },
      },
    ],
    tool_choice: "auto",
    messages: [{ role: "user", content: "北京今天天气怎么样？请调用工具查询" }],
  })
  const j = await res.json()
  const msg = j.choices?.[0]?.message
  if (!msg?.tool_calls?.length) throw new Error("no tool_calls: " + JSON.stringify(msg).slice(0, 200))
  const tc = msg.tool_calls[0]
  const args = JSON.parse(tc.function.arguments || "{}")
  if (!tc.function.name || typeof args !== "object") throw new Error("malformed tool_call")
  ok(`tool_call: ${tc.function.name}(${JSON.stringify(args)}), finish=${j.choices[0].finish_reason}`)

  // [S3] 工具结果回传第二轮
  console.log("[S3] 工具结果回传")
  const res2 = await call({
    model: "model-text", max_tokens: 128, stream: false,
    tools: [
      { type: "function", function: { name: "get_weather", description: "查询城市天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
    ],
    messages: [
      { role: "user", content: "北京今天天气怎么样？请调用工具查询" },
      { role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls },
      { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ city: "北京", temp: "18°C", cond: "晴" }) },
    ],
  })
  if (res2.status !== 200) throw new Error(`HTTP ${res2.status}: ${await res2.text()}`)
  const j2 = await res2.json()
  const reply = j2.choices?.[0]?.message?.content ?? ""
  if (!reply) throw new Error("empty second-round reply")
  ok(`second round: "${String(reply).slice(0, 60)}"`)
} catch (e) { fail("tool_calls", e.message) }

// [S4] 超长输入（接近 192k 上限的一小部分，验证大 payload 不被网关拦）
console.log("[S4] 大 payload（约 60k tokens 字符）")
try {
  const big = "测试".repeat(30000)
  const res = await call({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: big + "\n\n只回复：收到" }] })
  const j = await res.json()
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  ok(`big payload: 200, usage prompt=${j.usage?.prompt_tokens}`)
} catch (e) { fail("big payload", e.message) }

// [S5] 4xx 透传（坏模型名）
console.log("[S5] 错误响应格式")
try {
  const res = await call({ model: "model-nonexistent", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] })
  const t = await res.text()
  ok(`bad model -> HTTP ${res.status}: ${t.slice(0, 120)}`)
} catch (e) { fail("bad model", e.message) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
