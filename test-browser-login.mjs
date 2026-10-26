// 第三轮：浏览器登录方式的端到端模拟（粘贴 Network 面板 Cookie 头字符串）
// 模拟用户从 DevTools 复制的真实形态（含引号值、多域混排、httpOnly 项）
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

// 构造"用户从 Network 面板复制的 Cookie 头"：浏览器只会发 console.bce.baidu.com 域匹配的
function domainMatch(c, hostname) {
  if (!c.domain) return true
  const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain
  return hostname === domain || hostname.endsWith("." + domain)
}
const browserView = cookies.filter((c) => domainMatch(c, "console.bce.baidu.com"))
// 模拟 Network 面板里显示的 Cookie 头（值含特殊字符时 DevTools 显示带引号）
const pastedString = browserView
  .map((c) => {
    let v = String(c.value ?? "")
    if (/[:|;=\s]/.test(v)) v = `"${v}"`
    return `${c.name}=${v}`
  })
  .join("; ")

const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const hooks = await DuMatePlugin({})

console.log("[B1] 浏览器登录 callback 接受 Network 面板 Cookie 串")
try {
  const flow = await hooks.auth.methods[1].authorize()
  const r = await flow.callback(pastedString)
  if (r.type !== "success") throw new Error(JSON.stringify(r).slice(0, 200))
  if (!r.cookies?.some((c) => c.name === "bce-sessionid")) throw new Error("bce-sessionid 未保留")
  if (!r.name) throw new Error("displayName 未取到")
  ok(`success: name=${r.name}, cookies=${r.cookies.length} 条, accountId=${String(r.accountId).slice(0, 8)}…`)
} catch (e) { fail("浏览器登录 callback", e) }

console.log("[B2] 用 B1 的登录态走完整链路：usage / token / 网关 chat")
try {
  const flow = await hooks.auth.methods[1].authorize()
  const r = await flow.callback(pastedString)
  // magpie turns a "success" result into a persisted oauth seat; simulate that.
  const seat = { ...r, type: "oauth" }
  const getAuth = async () => seat
  const u = await hooks.auth.usage(getAuth)
  if (u.error) throw new Error("usage: " + u.error)
  const c = await hooks.auth.checkin(getAuth)
  if (c.outcome === "failed") throw new Error("checkin: " + c.message)
  const l = await hooks.auth.loader(getAuth)
  const res = await l.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "model-text", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
  if (res.status !== 200) throw new Error("gateway: " + res.status)
  ok(`usage=${u.balance} / checkin=${c.outcome} / chat=200`)
} catch (e) { fail("浏览器登录链路", e) }

console.log("[B3] 粘贴 document.cookie（缺 bce-sessionid）应被拒并给出正确指引")
try {
  const docOnly = browserView.filter((c) => !c.httpOnly)
    .map((c) => `${c.name}=${c.value}`).join("; ")
  const flow = await hooks.auth.methods[1].authorize()
  const r = await flow.callback(docOnly)
  if (r.type !== "failed") throw new Error("should reject: " + JSON.stringify(r).slice(0, 120))
  if (!/bce-sessionid/.test(r.error)) throw new Error("error 应指向 bce-sessionid: " + r.error)
  ok(`正确拒绝 + 指引: ${r.error.slice(0, 60)}…`)
} catch (e) { fail("document.cookie 拒绝", e) }

console.log("[B4] 手动方式（方式 3）同串同验")
try {
  const flow = await hooks.auth.methods[2].authorize()
  const r = await flow.callback(pastedString)
  if (r.type !== "success") throw new Error(JSON.stringify(r).slice(0, 150))
  ok("manual 方式同样通过")
} catch (e) { fail("manual 方式", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
