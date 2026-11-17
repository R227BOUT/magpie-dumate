// Keep magpie's shared reasoning levels while sending DuMate's own switches.
// Contributed by RanceLee (公众号 HelloRanceLee, 2026-11-13). 0.4.0 wires the
// level magpie hands the plugin to the request body; the model whitelist was
// then re-derived from live gateway evidence (2026-11-17) and SHRANK to the one
// model whose levels are demonstrable — see README「推理档位」.
//
// magpie conveys the level a user picked as the X-Magpie-Effort *header* on the
// plugin's fetch (the host does not rewrite the body), so headerEffort is a
// fallback: an explicit reasoning_effort in the body always wins.
//
// Live evidence that keeps every other model out of the whitelist:
// - glm-53: default run thinks (reasoning_tokens 276); ANY reasoning_effort
//   makes it answer without thinking (0). Advertising "high" would make users
//   think less than the default — the parameter is not a graded control.
// - model-text / dm-auto-model/text.L0: plain/low/high differences sit inside
//   generation-length noise and the direction is unstable.
// - kimi-k3: low<high on one run, low>high on the repeat — noise, not levels.
// - deepseek-v4-pro: repeats put high at or below low.
// - qwen4-max: 400 "required headers invalid" even with no extra parameters —
//   an upstream requirement this plugin does not satisfy, unrelated to levels.
//
// Anything outside this table is untouched: an unverified model must not gain
// controls the upstream may not honour.
//
// This table is the SINGLE SOURCE for the whitelist: models.mjs imports it to
// decide which catalog entries advertise levels (CR-001), and the catch (C19)
// fails if a second copy ever appears.
const DEEPSEEK = "deepseek-v41-flash"

/** Verified models → the variants (level keys) each may advertise. */
export const REASONING = {
  [DEEPSEEK]: { none: {}, low: {}, high: {}, max: {} },
}

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])

const clean = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "")

// 0.5.0: the object-level helpers are exported so the loader's unified request
// transform (budget.mjs era) can parse once, then apply routing → reasoning →
// budget → serialize once. normalizeReasoningBody keeps its exact v0.4.0
// string-in/string-out behaviour on top of them.
export function pickEffort(request, headerEffort) {
  if (!request || typeof request !== "object") return ""
  const own = clean(request.reasoning_effort)
  return EFFORTS.has(own) ? own : EFFORTS.has(clean(headerEffort)) ? clean(headerEffort) : ""
}

// DuMate's deepseek only has thinking on/off; "low" and "high" resolve to the
// same upstream strength (live: both think, none really turns it off). Every
// non-none level folds to "high"; max is passed through as itself.
export function applyReasoning(request, effort) {
  if (!request || typeof request !== "object" || !effort) return request
  if (!Object.hasOwn(REASONING, request.model)) return request
  const enabled = effort !== "none"
  if (!enabled) delete request.reasoning_effort
  else request.reasoning_effort = effort === "max" ? "max" : "high"
  // An explicit effort wins over conflicting switches left by an SDK/variant.
  request.thinking = { ...request.thinking, type: enabled ? "enabled" : "disabled" }
  request.enable_thinking = enabled
  return request
}

export function normalizeReasoningBody(body, headerEffort) {
  let text
  if (typeof body === "string") text = body
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) text = new TextDecoder().decode(body)
  else return body
  let request
  try { request = JSON.parse(text) } catch { return body }
  if (!request || typeof request !== "object" || !Object.hasOwn(REASONING, request.model)) return body

  const effort = pickEffort(request, headerEffort)
  if (!effort) return body

  return JSON.stringify(applyReasoning(request, effort))
}
