// Import DuMate's real model catalog (metadata only) and keep an independent
// snapshot under magpie's own config directory.
//
// RanceLee (公众号 HelloRanceLee, 2026-11-13) pointed out that 0.2.1 shipped
// only two hardcoded fallback models with no real context metadata. His fix
// reads the active account's opencode.json, strips everything that is not
// model metadata, and persists a sanitized snapshot so uninstalling DuMate
// cannot wipe the model list. See README.md -> 致谢.
import { readFileSync, statSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { discoverConfig } from "./paths.mjs"

// Keep this distinct from any community fork's directory: both plugins may be
// installed side by side and must not overwrite each other's snapshot.
export const SNAPSHOT_DIR_NAME = "magpie-dumate"

const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(id)
const positive = (n) => Number.isSafeInteger(n) && n > 0
const modalities = (list) => Array.isArray(list)
  ? [...new Set(list.filter((x) => ["text", "image", "audio", "video", "pdf"].includes(x)))]
  : ["text"]

function readJson(path) {
  const st = statSync(path)
  if (!st.isFile() || st.size <= 0 || st.size > 2 * 1024 * 1024) throw new Error("Invalid model catalog size")
  return JSON.parse(readFileSync(path, "utf8"))
}

// Only model metadata crosses this boundary. Endpoints, apiKey, headers,
// plugins, commands and permissions from the source config are never copied.
export function importModels(config) {
  const source = config?.provider?.QianfanPersonalQuota?.models
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Missing DuMate model catalog")
  const models = Object.create(null)
  let excluded = 0
  for (const [key, value] of Object.entries(source)) {
    const id = value?.id ?? key
    if (!validId(key) || !validId(id) || !value || typeof value !== "object") continue
    // Internal task routers, mocks, OCR, embeddings, rerankers and the
    // dedicated image generator are not chat entries.
    if ((key.startsWith("model-") && key !== "model-text") ||
        /(?:embedding|reranker|ocr|^llm-mock$|^dumate-image)/i.test(key)) {
      excluded++
      continue
    }
    // A display alias pointing at a real entry of its own is a duplicate.
    if (key !== id && Object.hasOwn(source, id)) {
      excluded++
      continue
    }
    const context = value.limit?.context ?? value.limit?.input
    const output = value.limit?.output
    if (!positive(context) || !positive(output)) continue
    const input = modalities(value.modalities?.input)
    if (!input.includes("text")) continue
    models[key] = {
      id,
      // e.g. the old "glm-5" key actually calls "model-text".
      name: key === id ? key : `${key} (API: ${id})`,
      limit: { context, output },
      tool_call: value.tool_call !== false,
      reasoning: id === "deepseek-v41-flash" || value.reasoning === true || value.capabilities?.reasoning === true,
      ...(id === "deepseek-v41-flash" ? { variants: { none: {}, low: {}, high: {}, max: {} } } : {}),
      attachment: input.some((x) => x !== "text"),
      modalities: { input, output: ["text"] },
    }
  }
  if (!Object.keys(models).length) throw new Error("No chat models in DuMate catalog")
  return { schema: 1, models, excluded }
}

// Snapshots are re-validated through the same filter, so a tampered or stale
// snapshot cannot smuggle an endpoint or a key into the provider config.
function fromSnapshot(snapshot) {
  if (snapshot?.schema !== 1) throw new Error("Unsupported catalog schema")
  return importModels({ provider: { QianfanPersonalQuota: { models: snapshot.models } } }).models
}

function saveSnapshot(path, catalog) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    renameSync(temp, path)
  } finally {
    try { unlinkSync(temp) } catch {
      // rename succeeded (or the temp file never existed) - nothing to clean.
    }
  }
}

// stateDir is magpie's plugin directory passed to the plugin factory. If the
// host does not supply it, fall back to magpie's standard config location.
export function loadModels({ sourcePath, snapshotPath, stateDir, userDataDir, env = process.env } = {}) {
  const store = join(stateDir || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie"), SNAPSHOT_DIR_NAME)
  snapshotPath ??= join(store, "models.snapshot.json")
  sourcePath ??= discoverConfig({ userDataDir, env })
  try {
    if (!sourcePath) throw new Error("Desktop model source unavailable")
    const catalog = importModels(readJson(sourcePath))
    try {
      if (JSON.stringify(readJson(snapshotPath)) === JSON.stringify(catalog)) return catalog.models
    } catch {
      // No usable snapshot yet - write one below.
    }
    try {
      if (snapshotPath === join(store, "models.snapshot.json")) mkdirSync(store, { recursive: true, mode: 0o700 })
      saveSnapshot(snapshotPath, catalog)
    } catch {
      // A read-only config dir must not break model discovery.
    }
    return catalog.models
  } catch {
    // Source missing or damaged: keep the last valid catalog, never clear it.
    try { return fromSnapshot(readJson(snapshotPath)) } catch {
      // Fresh install with no snapshot: use the dated reference catalog.
    }
    try { return fromSnapshot(readJson(new URL("./models.default.json", import.meta.url))) } catch {
      // Nothing usable - the plugin's hardcoded fallbacks still apply.
    }
    return {}
  }
}
