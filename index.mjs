// OpenCode & Magpie provider plugin for Baidu DuMate (百度搭子 / qianfan-desktop).
//
// DuMate (Baidu) signs in through login.bce.baidu.com (Baidu account web OAuth);
// the desktop app persists the session cookies AES-256-GCM-encrypted in
// <userData>/auth.json with the key in <userData>/.cookie-key. This plugin
// reuses that login (read-only) or accepts pasted cookies from a manual browser
// sign-in. Cookies are exchanged per-session for a gateway token via
// /api/dumate/app/token/get, then chats go straight to
// https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions (OpenAI-compatible)
// and burn the account's personal points. Daily check-in claims +500 points.
//
// Login methods:
//   1. desktop  — reuse the local DuMate app login (read-only, recommended)
//   2. browser  — open login.bce.baidu.com in the default browser, log in, then
//                 copy the `Cookie` request header of any request from DevTools
//                 → Network (httpOnly cookies are required, so document.cookie
//                 will NOT work); no DuMate install needed
//   3. manual   — paste a "name=value; ..." cookie string directly

import { createDecipheriv } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const PROVIDER_ID = "dumate"
const PROVIDER_NAME = "百度搭子 DuMate"

const CONSOLE_BASE = "https://console.bce.baidu.com"
const LOGIN_URL = "https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F"
const GATEWAY_BASE = "https://dumate-svc.baidu.com/gateway/apis/v1"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.82 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36"

const TOKEN_TTL_MS = 60 * 60 * 1000 // refresh token hourly; server gives ~14h

// Fallback model catalog (gateway has no /models endpoint). model-text is the
// auto-routing alias the desktop app itself uses; the gateway resolves it to
// live upstreams (observed 2026-10-26: responses always echo "model-text" —
// the router hides upstream identity; id prefix is "gd-").
const FALLBACK_MODELS = [
  { id: "model-text", name: "DuMate Auto (智能路由)", context: 192_000, output: 128_000, reasoning: true },
  { id: "dm-auto-model/text.L0", name: "DuMate Auto L0", context: 192_000, output: 128_000, reasoning: true },
]

// ---- DuMate desktop login files (read-only) --------------------------------

function desktopUserDataDir() {
  for (const envKey of ["DUMATE_USER_DATA_DIR"]) {
    const v = String(process.env[envKey] ?? "").trim()
    if (v) return v
  }
  // Default install keeps userData on D: with a junction from AppData; follow
  // the junction first, fall back to the standard Electron path.
  return join(process.env.APPDATA ?? "", "qianfan-desktop-app")
}

// The provider's picture, as magpie reads it: a data:image URI on the auth hook.
// Preference order, first hit wins:
//   1. icon.png next to this file — the app's own artwork, shipped with the plugin
//   2. the installed DuMate app's icon set — same picture, read in place
//   3. icon.svg next to this file — vector stand-in if neither PNG is there
//   4. '' — magpie then draws its generic tile
// Read-only throughout and every read is guarded, so a missing or unreadable
// icon degrades down the list instead of failing the plugin.
const MAX_ICON_URI = 1024 * 1024 // magpie's cap on the icon URI

// base64 inflates ~4/3, so measure the encoded string, not the file size.
function pngDataUri(buf) {
  if (!buf?.length) return ""
  // A file that isn't really a PNG would render as a broken image, so check
  // the signature before advertising it as image/png.
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return ""
  const encoded = buf.toString("base64")
  if (encoded.length + 32 > MAX_ICON_URI) return ""
  return `data:image/png;base64,${encoded}`
}

function iconFromPluginDir() {
  try {
    return pngDataUri(readFileSync(new URL("./icon.png", import.meta.url)))
  } catch {
    return ""
  }
}

function iconFromDesktopApp() {
  try {
    const installJson = JSON.parse(readFileSync(join(desktopUserDataDir(), "install.json"), "utf8"))
    const installDir = String(installJson?.installDir ?? "").trim()
    if (!installDir) return ""
    // magpie renders icons at 20-40px, so 256 is already past the point where a
    // bigger source helps; it just triples the base64 cost. Bigger sizes are the
    // last resort only (i.e. when 256/128 are missing from the install).
    for (const name of ["256x256.png", "128x128.png", "512x512.png"]) {
      try {
        const uri = pngDataUri(readFileSync(join(installDir, "program", "resources", "resources", "icons", name)))
        if (uri) return uri
      } catch {
        // try the next size
      }
    }
  } catch {
    // no desktop app installed — not an error
  }
  return ""
}

function iconFromBundle() {
  try {
    const svg = readFileSync(new URL("./icon.svg", import.meta.url), "utf8")
    if (!svg.trim()) return ""
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
  } catch {
    return ""
  }
}

// Evaluated once at load, in the documented preference order.
const pluginIcon = iconFromPluginDir() || iconFromDesktopApp() || iconFromBundle()

function readDesktopLogin() {
  try {
    const dir = desktopUserDataDir()
    const authPath = join(dir, "auth.json")
    const keyPath = join(dir, ".cookie-key")
    const st = statSync(authPath)
    if (!st.isFile() || st.size <= 0 || st.size > 1024 * 1024) return null
    const auth = JSON.parse(readFileSync(authPath, "utf8"))
    const cookiesField = auth?.cookies
    if (typeof cookiesField !== "string" || !cookiesField) return null
    const key = readFileSync(keyPath)
    if (key.length !== 32) return null
    const buf = Buffer.from(cookiesField, "base64")
    // Cipher layout (verified against a real auth.json): iv(12) + tag(16) + ct
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8")
    const arr = JSON.parse(plain)
    if (!Array.isArray(arr) || !arr.length) return null
    const profile = Array.isArray(auth.accountProfiles) && auth.activeProfileId
      ? auth.accountProfiles.find((p) => p?.profileId === auth.activeProfileId)
      : null
    return {
      cookies: arr,
      accountId: String(auth?.accountProfiles?.[0]?.bceAccountId ?? ""),
      name: String(profile?.displayName ?? auth?.accountProfiles?.[0]?.displayName ?? ""),
      source: "desktop",
    }
  } catch {
    return null
  }
}

// ---- Cookie helpers (replicates DuMate's utils/cookie.js exactly) ----------

// Serialize cookies for a hostname the way DuMate does: domain-filter, strip
// quotes, re-quote values containing : | ; = or spaces. POST endpoints reject
// the request ("登录凭证已过期") when the header is built any other way.
function buildCookieHeader(cookies, hostname) {
  const matched = cookies.filter((c) => {
    if (!c.domain) return true
    const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain
    return hostname === domain || hostname.endsWith("." + domain)
  })
  return matched
    .map((c) => {
      let val = String(c.value ?? "").replace(/^["']+|["']+$/g, "")
      if (/[:|;=\s]/.test(val)) val = `"${val}"`
      return `${c.name}=${val}`
    })
    .join("; ")
}

// csrftoken comes from the bce-user-info cookie value for the target host.
function extractCsrfToken(cookies, hostname) {
  const hit = cookies.find((c) => {
    if (c.name !== "bce-user-info") return false
    if (!hostname || !c.domain) return false
    const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain
    return hostname === domain || hostname.endsWith("." + domain)
  })
  return hit ? String(hit.value ?? "").replace(/^["']+|["']+$/g, "") : ""
}

// Parse a pasted "name=value; name2=value2" string into DuMate cookie objects.
// Pasted strings carry no domain info; ".baidu.com" matches every host we call
// (console.bce.baidu.com is a subdomain), which is exactly what we need.
function parseCookieString(raw) {
  const out = []
  for (const part of String(raw ?? "").split(/;\s*/)) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    let value = part.slice(idx + 1).trim()
    if (!name) continue
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    out.push({ name, value, domain: ".baidu.com" })
  }
  return out
}

// BDUSS/STOKEN/bce-sessionid are httpOnly, so document.cookie can never carry
// them — and matrix testing showed the console API needs at least bce-sessionid
// alongside the visible cookies. The browser method therefore asks for the
// DevTools Network "Cookie" request header (or the Application panel export),
// which includes httpOnly entries.
const REQUIRED_COOKIES = ["bce-sessionid"]

// ---- Text safety for user-facing messages ----------------------------------

// Everything a hook returns as `message` lands on the account card, in magpie's
// log and on the terminal. A remote answer is not trusted with control
// characters: a newline forges a log line, an escape sequence drives the
// terminal, and a bidi override can turn a name inside out. Visible characters
// are kept up to a length that fits a card, counting code points so a surrogate
// pair is never cut in half.
const cardText = (value, max = 200) => {
  const cleaned = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .trim()
  const points = Array.from(cleaned)
  return points.length > max ? points.slice(0, max).join("") : cleaned
}

// checkin runs under a shared 2-minute budget across every provider's accounts,
// asked one account at a time; a slow account must not eat the others' share.
// A hook cut short answers failed, which the host retries in half an hour.
const CHECKIN_BUDGET_MS = 25 * 1000

// ---- Console API (GET works with plain cookie header) ----------------------

// Baidu's console redirects expired sessions to an HTML login page with HTTP
// 200 (fetch follows the 302), so an HTML body means "sign-in expired", not an
// API error — map it to signIn=expired so magpie prompts a re-login.
function consoleError(payload, fallback) {
  const msg = typeof payload?.message === "string" ? payload.message : JSON.stringify(payload?.message ?? "")
  const err = new Error(`DuMate 接口错误: ${msg || fallback}`)
  if (/登录凭证|重新登录|login/i.test(msg)) err.signIn = "expired"
  return err
}

function htmlSignInError() {
  const err = new Error("DuMate 登录态已失效（接口返回登录页），请重新登录")
  err.signIn = "expired"
  return err
}

async function consoleGet(path, cookieStr) {
  const res = await fetch(`${CONSOLE_BASE}${path}`, {
    headers: {
      Cookie: cookieStr,
      "User-Agent": UA,
      Accept: "application/json",
      Referer: `${CONSOLE_BASE}/`,
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let payload = null
  try { payload = JSON.parse(text) } catch {}
  if (payload === null || typeof payload !== "object") {
    // HTML login page (session expired) or other non-JSON body.
    if (/登录|login|<!DOCTYPE|<html/i.test(text.slice(0, 500))) throw htmlSignInError()
    throw new Error(`DuMate console HTTP ${res.status} 非 JSON 响应`)
  }
  if (!res.ok) throw new Error(`DuMate console HTTP ${res.status}`)
  if (payload?.code !== 0 || payload?.success === false) throw consoleError(payload, `code=${payload?.code}`)
  return payload?.result
}

// POST needs domain-filtered cookies + csrftoken header + XHR headers.
async function consolePost(path, body, cookies) {
  const cookieStr = buildCookieHeader(cookies, "console.bce.baidu.com")
  const csrftoken = extractCsrfToken(cookies, "console.bce.baidu.com")
  const res = await fetch(`${CONSOLE_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: CONSOLE_BASE,
      Referer: `${CONSOLE_BASE}/`,
      Cookie: cookieStr,
      csrftoken,
      "User-Agent": UA,
      Accept: "application/json",
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let payload = null
  try { payload = JSON.parse(text) } catch {}
  if (payload === null || typeof payload !== "object") {
    if (/登录|login|<!DOCTYPE|<html/i.test(text.slice(0, 500))) throw htmlSignInError()
    throw new Error(`DuMate console HTTP ${res.status} 非 JSON 响应`)
  }
  if (!res.ok) throw new Error(`DuMate console HTTP ${res.status}`)
  if (payload?.code !== 0 || payload?.success === false) throw consoleError(payload, `code=${payload?.code}`)
  return payload?.result
}

// ---- Gateway token (single-flight cache) ------------------------------------

const tokenCache = new Map() // cookieHeader -> { token, expiresAt, pending }

async function fetchGatewayToken(cookieHeader) {
  const cached = tokenCache.get(cookieHeader)
  if (cached && Date.now() < cached.expiresAt - 5 * 60_000) return cached
  let pending = tokenCache.get(cookieHeader + "\u0000pending")
  if (!pending) {
    pending = (async () => {
      const result = await consoleGet("/api/dumate/app/token/get", cookieHeader)
      const token = String(result?.token ?? "")
      if (!token) throw new Error("DuMate 未返回 gateway token")
      const expiresAt = result?.expired_at ? Date.parse(result.expired_at) : Date.now() + TOKEN_TTL_MS
      return { token, expiresAt: Number.isFinite(expiresAt) && expiresAt > Date.now() ? expiresAt : Date.now() + TOKEN_TTL_MS }
    })().finally(() => tokenCache.delete(cookieHeader + "\u0000pending"))
    tokenCache.set(cookieHeader + "\u0000pending", pending)
  }
  const next = await pending
  tokenCache.set(cookieHeader, next)
  return next
}

// ---- Plugin ----------------------------------------------------------------

export const DuMatePlugin = async () => {
  const consoleCookies = async (auth) => {
    if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) throw signInError(auth)
    return auth.cookies
  }
  const signInError = (auth) => {
    const err = new Error(
      auth?.source === "desktop"
        ? "DuMate 桌面端登录态已失效，请打开百度搭子重新登录后在此重新登录"
        : "DuMate 登录态已失效，请重新登录",
    )
    err.signIn = "expired"
    return err
  }

  const cookieHeaderOf = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join("; ")

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: GATEWAY_BASE,
        ...was,
        models: {
          ...Object.fromEntries(
            FALLBACK_MODELS.map((m) => [
              m.id,
              {
                name: m.name,
                limit: { context: m.context, output: m.output },
                tool_call: true,
                reasoning: !!m.reasoning,
                attachment: false,
                modalities: { input: ["text"], output: ["text"] },
              },
            ]),
          ),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        return provider.models
      },
    },

    auth: {
      provider: PROVIDER_ID,
      icon: pluginIcon,

      async refresh(auth) {
        // Cookies have no refresh flow. For desktop-source seats, follow the
        // app: if it re-logged-in, pick up its newer cookies transparently
        // (raccoon-style) instead of forcing a magpie re-login.
        if (auth?.type !== "oauth" || auth.source !== "desktop") return undefined
        const d = readDesktopLogin()
        if (!d) return undefined
        const oldHeader = (auth.cookies ?? []).map((c) => `${c.name}=${c.value}`).join("; ")
        const newHeader = d.cookies.map((c) => `${c.name}=${c.value}`).join("; ")
        if (newHeader === oldHeader) return undefined
        return {
          access: "cookie:" + newHeader,
          refresh: "",
          expires: 0,
          source: "desktop",
          accountId: d.accountId || auth.accountId,
          name: d.name || auth.name || "",
          cookies: d.cookies,
        }
      },

      async loader(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return {
            baseURL: GATEWAY_BASE,
            apiKey: "dumate",
            async fetch() {
              return new Response(
                JSON.stringify({ error: { message: `DuMate 登录态读取失败: ${e?.message ?? e}`, type: "api_error" } }),
                { status: 502, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" } },
              )
            },
          }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return {
            baseURL: GATEWAY_BASE,
            apiKey: "dumate",
            async fetch() {
              return new Response(
                JSON.stringify({ error: { message: "DuMate 未登录，请先在 Magpie 登录", type: "authentication_error" } }),
                { status: 401, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" } },
              )
            },
          }
        }
        const cookies = auth.cookies
        return {
          baseURL: GATEWAY_BASE,
          apiKey: "dumate",
          async fetch(input, init = {}) {
            const req = input instanceof Request ? input : null
            let bodyText = init?.body
            if (bodyText === undefined && req) bodyText = await req.clone().text()
            let cred
            try {
              cred = await fetchGatewayToken(cookieHeaderOf(cookies))
            } catch (e) {
              const expired = e?.signIn === "expired"
              return new Response(
                JSON.stringify({ error: { message: e?.message ?? String(e), type: expired ? "authentication_error" : "api_error" } }),
                { status: expired ? 401 : 502, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": expired ? "expired" : "kept" } },
              )
            }
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.set("Authorization", `Bearer ${cred.token}`)
            headers.set("Content-Type", "application/json")
            headers.delete("x-api-key")
            headers.delete("content-length")
            const res = await fetch(req ? req.url : input, {
              ...init,
              method: init?.method ?? req?.method ?? "POST",
              headers,
              body: bodyText,
            })
            if (res.status === 401) {
              tokenCache.delete(cookieHeaderOf(cookies))
              return new Response(
                JSON.stringify({ error: { message: "DuMate gateway token 已失效并清除缓存，请重试或重新登录", type: "authentication_error" } }),
                { status: 401, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" } },
              )
            }
            return res
          },
        }
      },

      async usage(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return { error: cardText(e?.message) || "登录态读取失败", signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return { error: "没有登录信息，请先在 Magpie 登录", signIn: "kept" }
        }
        try {
          const cookies = await consoleCookies(auth)
          const header = cookieHeaderOf(cookies)
          let overviewError = null
          const [overview, info] = await Promise.all([
            consoleGet(
              "/api/dumate/points/quota_overview?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true",
              header,
            ).catch((e) => {
              overviewError = e
              return null
            }),
            consoleGet("/api/dumate/points/loginBonusInfo", header).catch(() => null),
          ])
          // A dead session is a sign-in problem, not "the quota endpoint is
          // down": rethrow so the signIn=expired marker survives and magpie
          // asks for a re-login instead of retrying a session that cannot work.
          if (!overview) throw overviewError ?? new Error("quota_overview 不可用")
          const total = parseFloat(overview.totalPoints) || 0
          const used = parseFloat(overview.usedPoints) || 0
          const packs = [...(overview.subscription ?? []), ...(overview.incremental ?? [])]
          let soonest = null
          for (const p of packs) {
            if (p?.status !== "active") continue
            // expireDate can be null on never-expiring packs — Number(null)*1000
            // would yield 1970, so guard it.
            const expMs = p.expireDate == null ? NaN : Number(p.expireDate) * 1000
            if (!Number.isFinite(expMs) || expMs <= 0) continue
            if (!soonest || expMs < soonest.ms) soonest = { ms: expMs, points: parseFloat(p.totalPoints) || 0 }
          }
          return {
            plan: info && info.totalTimes ? `已签到 ${info.totalTimes} 天` : "Free",
            balance: `${(total - used).toFixed(2)} 积分`,
            windows: [
              {
                name: "Points",
                used: total > 0 ? (100 * used) / total : 0,
                display: `${used.toFixed(2)} / ${total.toFixed(2)}`,
                amount: used,
                limit: total,
                unit: "points",
                ...(soonest
                  ? { runsOutAt: new Date(soonest.ms).toISOString(), runsOut: Math.min(total - used, soonest.points) }
                  : {}),
              },
            ],
            user: auth.name || auth.accountId || "DuMate",
            signIn: "kept",
          }
        } catch (e) {
          return { error: cardText(e?.message) || "用量查询失败", signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
      },

      // Daily check-in. magpie asks once per Beijing day per signed-in account
      // while the provider's check-in switch is on, and again later that day
      // after a failure.
      //
      // Outcomes (the host's vocabulary): done = already claimed today,
      // claimed = this run claimed it, inactive = touched but nothing was
      // granted, failed = nothing claimed and worth retrying. `signIn:
      // "expired"` on a failed result tells magpie to mark the account and stop
      // retrying until the user signs in again.
      async checkin(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return {
            outcome: "failed",
            message: cardText(e?.message) || "登录态读取失败",
            ...(e?.signIn === "expired" ? { signIn: "expired" } : {}),
          }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return { outcome: "failed", message: "没有登录信息，请先在 Magpie 登录" }
        }
        const deadline = Date.now() + CHECKIN_BUDGET_MS
        try {
          const cookies = await consoleCookies(auth)
          const header = cookieHeaderOf(cookies)
          // hasIssued=true means today's bonus already landed. Read it before
          // touching the endpoint so "claimed now" is told apart from
          // "claimed hours ago".
          let before = null
          try {
            before = await consoleGet("/api/dumate/points/loginBonusInfo", header)
          } catch (e) {
            // A dead session here is worth reporting, not swallowing: the POST
            // below would fail with a vaguer message.
            if (e?.signIn === "expired") throw e
          }
          if (before?.hasIssued === true) {
            return {
              outcome: "done",
              message: `今日已签到（累计 ${cardText(before.totalTimes) || "?"} 天）`,
            }
          }
          if (Date.now() >= deadline) {
            return { outcome: "failed", message: "签到超时，稍后自动重试" }
          }
          const beforePoints = parseFloat(before?.totalPoints ?? "0") || 0
          await consolePost("/api/dumate/points/loginBonus", {}, cookies)
          let after = null
          try {
            after = await consoleGet("/api/dumate/points/loginBonusInfo", header)
          } catch {}
          if (after?.hasIssued === true) {
            // Credit is derived from the actual delta, not hardcoded (+500 today
            // but the amount has changed before and may change again).
            const delta = Math.max(0, Math.round((parseFloat(after.totalPoints ?? "0") || 0) - beforePoints))
            return {
              outcome: "claimed",
              ...(delta ? { credit: delta } : {}),
              message: `签到成功${delta ? ` +${delta} 积分` : ""}（累计 ${cardText(after.totalTimes) || "?"} 天）`,
            }
          }
          // The POST went through but the ledger shows nothing yet. Saying
          // "claimed" would be a claim we cannot back; `inactive` is the honest
          // outcome, and the host re-asks later in the day.
          return { outcome: "inactive", message: "签到请求已提交，但今日积分尚未到账（可能延迟，稍后自动重试）" }
        } catch (e) {
          return {
            outcome: "failed",
            message: cardText(e?.message) || "签到失败",
            ...(e?.signIn === "expired" ? { signIn: "expired" } : {}),
          }
        }
      },

      methods: [
        {
          type: "oauth",
          label: "百度搭子桌面端登录态（本机 auth.json，只读复用）",
          authorize: async () => ({
            url: "",
            instructions: "直接复用本机百度搭子客户端的登录态（读取 auth.json + .cookie-key，只读，不写任何文件）。",
            method: "auto",
            async callback() {
              const d = readDesktopLogin()
              if (!d) {
                return {
                  type: "failed",
                  error: "未检测到本机百度搭子登录态（qianfan-desktop-app/auth.json）。请先安装并登录百度搭子，或改用浏览器登录方式。",
                }
              }
              return {
                type: "success",
                access: "cookie:" + d.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
                refresh: "",
                expires: 0,
                source: "desktop",
                accountId: d.accountId || PROVIDER_NAME,
                name: d.name || "",
                cookies: d.cookies,
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "百度账号浏览器登录（无需安装百度搭子）",
          authorize: async () => ({
            url: LOGIN_URL,
            instructions:
              "1. 点击上方链接在浏览器登录百度账号（登录成功后会跳到 console.bce.baidu.com）。\n" +
              "2. 登录完成后，在 console.bce.baidu.com 页面按 F12 打开 DevTools → Network（网络）面板，刷新页面，点第一个请求。\n" +
              "3. 在 Request Headers（请求标头）里找到 Cookie 一行，右键 → Copy value（复制值），把整段粘贴到下方。\n" +
              "（不要用 document.cookie：关键登录 Cookie 是 httpOnly，控制台拿不到）",
            method: "code",
            async callback(input) {
              const raw = String(input ?? "").trim().replace(/^["']|["']$/g, "")
              if (!raw || !raw.includes("=")) return { type: "failed", error: "请粘贴请求头中 Cookie 行的完整值" }
              const cookies = parseCookieString(raw)
              const missing = REQUIRED_COOKIES.filter((n) => !cookies.some((c) => c.name === n))
              if (missing.length) {
                return { type: "failed", error: `Cookie 缺少关键字段：${missing.join(", ")}。请确认复制的是 DevTools Network 面板请求头里的 Cookie 值（不是 document.cookie）` }
              }
              const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
              // Probe: validate the cookies actually work before accepting.
              let info = null
              try {
                info = await consoleGet("/api/dumate/user/info", header)
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}。请重新登录并复制新的 Cookie` }
              }
              return {
                type: "success",
                access: "cookie:" + header,
                refresh: "",
                expires: 0,
                source: "browser",
                accountId: String(info?.bceAccountId ?? PROVIDER_NAME),
                name: String(info?.displayName ?? ""),
                cookies,
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "手动粘贴 Cookie 字符串",
          authorize: async () => ({
            url: "",
            instructions: "粘贴完整的 Cookie 字符串（name=value; name2=value2 格式，需包含 bce-sessionid，来自 console.bce.baidu.com 的请求头）：",
            method: "code",
            async callback(input) {
              const raw = String(input ?? "").trim()
              const cookies = parseCookieString(raw)
              if (cookies.length < 2) return { type: "failed", error: "无法解析 Cookie 字符串" }
              const missing = REQUIRED_COOKIES.filter((n) => !cookies.some((c) => c.name === n))
              if (missing.length) return { type: "failed", error: `Cookie 缺少关键字段：${missing.join(", ")}` }
              const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
              let info = null
              try {
                info = await consoleGet("/api/dumate/user/info", header)
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}` }
              }
              return {
                type: "success",
                access: "cookie:" + header,
                refresh: "",
                expires: 0,
                source: "manual",
                accountId: String(info?.bceAccountId ?? PROVIDER_NAME),
                name: String(info?.displayName ?? ""),
                cookies,
              }
            },
          }),
        },
      ],
    },
  }
}

export default DuMatePlugin

// Test hooks: pure helpers exported for unit tests (no network).
export const _internal = {
  parseCookieString,
  buildCookieHeader,
  extractCsrfToken,
  readDesktopLogin,
  iconFromPluginDir,
  iconFromDesktopApp,
  iconFromBundle,
}
