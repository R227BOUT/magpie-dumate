// 离线冒烟测试：不装进 magpie，直接驱动插件导出的 hooks，
// 用本机 DuMate 桌面端登录态跑通 usage / checkin / loader->chat 全链路。
// 用法：node test-smoke.cjs
import { DuMatePlugin } from "./index.mjs"
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

const fakeAuth = {
  type: "oauth",
  cookies,
  source: "desktop",
  accountId: auth.accountProfiles?.[0]?.bceAccountId ?? "",
  name: auth.accountProfiles?.[0]?.displayName ?? "",
}
let saved = null
const getAuth = async () => saved ?? fakeAuth

const ok = (name) => console.log(`  PASS ${name}`)
const fail = (name, err) => { console.error(`  FAIL ${name}:`, err?.message ?? err); process.exitCode = 1 }

console.log("[1] 加载插件")
const hooks = await DuMatePlugin({})
if (hooks?.auth?.provider !== "dumate") fail("plugin shape")
else ok("plugin shape: auth.provider=dumate, methods=" + hooks.auth.methods.length)

console.log("[2] usage hook")
try {
  const u = await hooks.auth.usage(getAuth)
  if (u.error) fail("usage", new Error(u.error))
  else { ok(`usage: ${u.balance} / plan=${u.plan} / user=${u.user}`); console.log("      windows:", JSON.stringify(u.windows)) }
} catch (e) { fail("usage", e) }

console.log("[3] checkin hook（今日应已签到=done）")
try {
  const c = await hooks.auth.checkin(getAuth)
  ok(`checkin: outcome=${c.outcome} ${c.message ?? ""}`)
} catch (e) { fail("checkin", e) }

console.log("[4] loader → 真实调用网关（消耗少量积分，max_tokens=16）")
try {
  const l = await hooks.auth.loader(getAuth)
  if (typeof l.fetch !== "function") throw new Error("loader.fetch missing")
  const res = await l.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "model-text", max_tokens: 16, stream: false, messages: [{ role: "user", content: "回复 OK" }] }),
  })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`)
  const content = body?.choices?.[0]?.message?.content ?? ""
  ok(`gateway chat: HTTP 200, content="${String(content).slice(0, 30)}", usage=${JSON.stringify(body?.usage ?? {})}`)
} catch (e) { fail("loader chat", e) }

console.log("[5] 未登录时的 loader 拦截")
try {
  const l = await hooks.auth.loader(async () => ({}))
  const res = await l.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", { method: "POST", body: "{}" })
  if (res.status === 401) ok("unauth fetch -> 401 + X-Magpie-Sign-In=" + res.headers.get("x-magpie-sign-in"))
  else fail("unauth fetch", new Error("status=" + res.status))
} catch (e) { fail("unauth loader", e) }

console.log("[6] config hook（现在是 async 函数，接收 config 对象）")
try {
  const config = {}
  await hooks.config(config)
  const prov = config.provider?.dumate
  if (!prov?.api?.includes("dumate-svc.baidu.com")) throw new Error("provider config missing")
  ok(`config: models=${Object.keys(prov.models).join(",")}, npm=${prov.npm}`)
} catch (e) { fail("config", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
