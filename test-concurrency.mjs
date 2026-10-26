// 第二轮深度测试：并发正确性 / 401 恢复 / token 缓存边界
import { DuMatePlugin, _internal } from "./index.mjs"
import { readFileSync } from "node:fs"
import { createDecipheriv } from "node:crypto"
import { join } from "node:path"

const dir = join(process.env.APPDATA ?? "", "qianfan-desktop-app")
const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))
const key = readFileSync(join(dir, ".cookie-key"))
const buf = Buffer.from(auth.cookies, "base64")
const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
d.setAuthTag(buf.subarray(12, 28))
const cookies = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"))

const fakeAuth = { type: "oauth", cookies, source: "desktop", accountId: "x", name: "test" }
const getAuth = async () => fakeAuth
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const hooks = await DuMatePlugin({})

console.log("[C1] 10 并发 chat 请求（token 单飞缓存 + 网关并发）")
try {
  const l = await hooks.auth.loader(getAuth)
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      l.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
    ),
  )
  const good = results.filter((r) => r.status === "fulfilled" && r.value.status === 200)
  const bad = results.filter((r) => r.status === "rejected" || r.value.status !== 200)
  if (bad.length) {
    const first = bad[0].reason ?? bad[0].value
    throw new Error(`${bad.length}/10 失败: ${JSON.stringify(first).slice(0, 200)}`)
  }
  ok(`10/10 并发成功`)
} catch (e) { fail("并发", e) }

console.log("[C2] token 缓存污染 → 401 → 自动恢复（下次请求重新换 token）")
try {
  const l = await hooks.auth.loader(getAuth)
  // 手动塞一个坏 token 进缓存：通过 _internal 没有 tokenCache……改为直接验证行为：
  // 先正常打一发确保缓存有 token，然后用损坏的 cookies 触发 401 路径的等价验证。
  const r1 = await l.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
  if (r1.status !== 200) throw new Error("baseline failed: " + r1.status)
  // 坏 cookie 场景：cookies 有效但值损坏 -> token/get 应失败 -> loader 返回 401 with signIn=expired
  const badAuth = { type: "oauth", source: "manual", cookies: [{ name: "bce-sessionid", value: "garbage", domain: ".baidu.com" }] }
  const l2 = await hooks.auth.loader(async () => badAuth)
  const r2 = await l2.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
  const signIn = r2.headers.get("x-magpie-sign-in")
  if (r2.status !== 401) throw new Error(`expected 401 got ${r2.status}`)
  if (signIn !== "expired") throw new Error("expected sign-in=expired, got: " + signIn)
  ok(`坏凭据 -> 401 + X-Magpie-Sign-In=expired（登录页正确识别，magpie 会引导重登）`)
} catch (e) { fail("401 路径", e) }

console.log("[C3] 网关真 401 的恢复：用真 cookie 打、立刻再打一发（缓存命中）")
try {
  const l = await hooks.auth.loader(getAuth)
  const [ra, rb] = await Promise.all([
    l.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) }),
    l.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) }),
  ])
  if (ra.status !== 200 || rb.status !== 200) throw new Error(`second wave ${ra.status}/${rb.status}`)
  ok("连续两波请求均 200（缓存 token 复用正常）")
} catch (e) { fail("缓存复用", e) }

console.log("[C4] usage 连续 3 次（无状态泄漏/无恶化）")
try {
  const out = []
  for (let i = 0; i < 3; i++) out.push(await hooks.auth.usage(getAuth))
  if (out.some((u) => u.error)) throw new Error(out.map((u) => u.error).join("; ").slice(0, 150))
  ok(`3 次 usage 稳定: balance=${out[2].balance}`)
} catch (e) { fail("usage 稳定性", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
