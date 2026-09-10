import path from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { connect } from "node:net"
import express from "express"
import { logfireQuery } from "./logfire.mjs"
import { dwhQuery, sqlTypes } from "./dwh.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, "..", "dist")
const isProduction = existsSync(path.join(distDir, "index.html"))

const app = express()

// Live telemetry: never let a browser, proxy, or CDN cache these responses.
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
})
const DEFAULT_RANGE_HOURS = 24
const TRACE_ID_RE = /^[0-9a-f]{32}$/i

const ALLOWED_ENVIRONMENTS = new Set(["dev", "local", "prod", "test"])
const DEFAULT_ENVIRONMENT = "prod"

/** Reads ?env= from the request, falling back to prod for anything unrecognized. */
function resolveEnv(req) {
  const env = String(req.query.env ?? DEFAULT_ENVIRONMENT)
  return ALLOWED_ENVIRONMENTS.has(env) ? env : DEFAULT_ENVIRONMENT
}

/** Reads ?minTimestamp=&maxTimestamp= from the request, falling back to the last 24 hours
 * when absent or invalid. Both are ISO timestamps, passed straight through to Logfire. */
function resolveTimeRange(req) {
  const min = req.query.minTimestamp ? new Date(String(req.query.minTimestamp)) : null
  const max = req.query.maxTimestamp ? new Date(String(req.query.maxTimestamp)) : null
  if (min && max && !Number.isNaN(min.getTime()) && !Number.isNaN(max.getTime()) && min < max) {
    return { minTimestamp: min.toISOString(), maxTimestamp: max.toISOString() }
  }
  const now = new Date()
  return {
    minTimestamp: new Date(now.getTime() - DEFAULT_RANGE_HOURS * 60 * 60 * 1000).toISOString(),
    maxTimestamp: now.toISOString(),
  }
}

function sqlList(values) {
  return values.map((v) => `'${v}'`).join(",")
}

const SKIPPED_SPANS = new Set(["POST /api/v2/chat", "OPTIONS /api/v2/chat", "chat.request"])

/** A trace counts as "answered" if it produced a chat message or a solution-agent
 * final result; used everywhere a chat.request is checked for a real response. */
const ANSWERED_CONDITION_SQL = `((span_name LIKE 'chat %' AND attributes->'gen_ai.output.messages' IS NOT NULL AND attributes->'gen_ai.output.messages' != '[]') OR (attributes->>'gen_ai.operation.name' = 'invoke_agent' AND attributes->>'final_result' IS NOT NULL AND attributes->>'final_result' != ''))`

/** Tool call failures come in two shapes: normal agent-routed MCP calls, and "direct" calls that
 * bypass the agent (used by retrieve_initial_data's background prefetches). Each shape uses a
 * different logging_args layout, so they're queried and labeled separately. */
const AGENT_TOOL_FAILURE_TEMPLATES = ["MCP tool %s raised exception: %s", "MCP tool %s timed out after %ds"]
const AGENT_TOOL_FAILURE_TEMPLATE_LIST = AGENT_TOOL_FAILURE_TEMPLATES.map((t) => `'${t}'`).join(",")
const DIRECT_TOOL_FAILURE_TEMPLATES = ["%s(%s) timed out after %ds", "%s(%s): MCP tool reported an error: %s"]
const DIRECT_TOOL_FAILURE_TEMPLATE_LIST = DIRECT_TOOL_FAILURE_TEMPLATES.map((t) => `'${t}'`).join(",")

/** Canonical LLM Judge block events, keyed by dashboard label. Each block is logged twice under
 * different span names within the same trace (a generic line plus a shorter duplicate) — only the
 * generic span names are counted here to avoid double-counting the same block. */
const SECURITY_JUDGE_KINDS = {
  "Blocked user input": "LLM Judge flagged input",
  "Blocked tool output": "LLM Judge flagged tool output",
  "Blocked MCP tool result": "LLM Judge blocked output from MCP tool %s",
}
const SECURITY_JUDGE_SPAN_LIST = sqlList(Object.values(SECURITY_JUDGE_KINDS))
const SECURITY_JUDGE_LABELS = Object.fromEntries(
  Object.entries(SECURITY_JUDGE_KINDS).map(([label, spanName]) => [spanName, label]),
)

/** Extracts assistant text from a chat span's gen_ai.output.messages attribute. */
function extractChatOutput(attributes) {
  const messages = attributes?.["gen_ai.output.messages"]
  if (!Array.isArray(messages)) return null
  const texts = []
  for (const m of messages) {
    if (!Array.isArray(m?.parts)) continue
    for (const part of m.parts) {
      if (part?.type === "text" && part.content) texts.push(part.content)
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : null
}

/** Classifies one span into a labeled step with whatever output Logfire actually captured for it. */
function classifyStep(row) {
  const attributes = row.attributes ?? {}
  const spanName = row.span_name

  if (attributes["gen_ai.operation.name"] === "invoke_agent") {
    const cost = attributes["logfire.metrics"]?.["operation.cost"]?.total
    return {
      type: "agent",
      label: "Agent reasoning",
      output: attributes.final_result ?? null,
      costUsd: typeof cost === "number" ? cost : null,
    }
  }
  if (spanName.startsWith("chat ")) {
    const model = attributes.model_name ?? attributes["gen_ai.request.model"] ?? spanName.slice(5)
    return { type: "chat", label: `LLM call · ${model}`, output: extractChatOutput(attributes) }
  }
  if (spanName.startsWith("tools/call ")) {
    // `logfire.*` and `code.*` are Logfire/OTel's own span metadata, not the tool call's actual
    // payload — everything else here is whatever the tool call itself logged (arguments, result).
    const payload = Object.fromEntries(
      Object.entries(attributes).filter(([key]) => !key.startsWith("logfire.") && !key.startsWith("code.")),
    )
    return {
      type: "tool",
      label: spanName.slice(11),
      output: Object.keys(payload).length > 0 ? JSON.stringify(payload, null, 2) : null,
    }
  }
  if (spanName === "solution_agent_finished") {
    return {
      type: "finish",
      label: "Solution agent finished",
      output: attributes.outcome ? `Outcome: ${attributes.outcome}` : null,
    }
  }
  return {
    type: "info",
    label: row.message && row.message !== spanName ? row.message : spanName,
    output: null,
  }
}

/** Fetches every span in the given traces and classifies each into a step, grouped by trace_id.
 * Also returns the set of traces containing an error/warning-level span. */
async function fetchStepsByTrace(traceIds, insights) {
  const stepsByTrace = new Map()
  const exceptionTraces = new Set()
  if (traceIds.length === 0) return { stepsByTrace, exceptionTraces }
  const traceList = sqlList(traceIds)
  const result = await logfireQuery(
    `SELECT trace_id, start_timestamp, duration, span_name, message, level, attributes, exception_message, exception_type FROM records WHERE trace_id IN (${traceList}) ORDER BY start_timestamp`,
    insights,
  )
  for (const row of result.data) {
    if (row.level >= 17) exceptionTraces.add(row.trace_id)
    if (SKIPPED_SPANS.has(row.span_name)) continue
    if (!stepsByTrace.has(row.trace_id)) stepsByTrace.set(row.trace_id, [])
    const classified = classifyStep(row)
    stepsByTrace.get(row.trace_id).push({
      costUsd: null,
      ...classified,
      exceptionMessage: row.exception_message ?? null,
      exceptionType: row.exception_type ?? null,
      startedAt: row.start_timestamp,
      durationSec: row.duration ?? 0,
      isError: row.level >= 17,
    })
  }
  return { stepsByTrace, exceptionTraces }
}

/** Looks up the model and ticket active in each trace, so a bare error/failure record (which
 * usually carries neither itself — the flat `ticket_id` attribute is unpopulated dead weight,
 * always "-") can be attributed via its trace's invoke_agent span (model) and chat.request span
 * (ticket, from context.entity_id when context.entity_type is "ticket"). */
async function fetchTraceContext(traceIds, range) {
  const modelByTrace = new Map()
  const ticketByTrace = new Map()
  const validIds = traceIds.filter((id) => TRACE_ID_RE.test(id))
  if (validIds.length === 0) return { modelByTrace, ticketByTrace }
  const result = await logfireQuery(
    `SELECT trace_id, span_name, COALESCE(attributes->>'model_name', attributes->>'model') as model, attributes->'context'->>'entity_type' as entity_type, attributes->'context'->>'entity_id' as entity_id FROM records WHERE trace_id IN (${sqlList(validIds)}) AND (COALESCE(attributes->>'model_name', attributes->>'model') IS NOT NULL OR span_name = 'chat.request') ORDER BY start_timestamp`,
    range,
  )
  for (const row of result.data) {
    if (row.model && !modelByTrace.has(row.trace_id)) modelByTrace.set(row.trace_id, row.model)
    if (row.span_name === "chat.request" && row.entity_type === "ticket" && row.entity_id && !ticketByTrace.has(row.trace_id)) {
      ticketByTrace.set(row.trace_id, row.entity_id)
    }
  }
  return { modelByTrace, ticketByTrace }
}

const UNKNOWN_GROUP = "Ukjent"
// Per-query Logfire responses are capped at 1000 rows (see logfire.mjs), and a full-history
// GROUP BY reference_number can easily exceed that once the solution agent has run for a while.
// Splitting the lookback into monthly windows keeps each window's distinct-ticket count (and
// thus its row count) well under the cap; totals are then summed across windows in JS.
const SOLUTION_LOOKBACK_MONTHS = 24
// Confidence/sources/tools require full step detail (one query per trace), which is bounded by
// the same 1000-row cap on total spans - so those breakdowns are computed from only the most
// recent runs in a group, not the group's full history (mirrors the existing `detailedTickets`
// cap used for the main dashboard's per-ticket solution view).
const SOLUTION_SAMPLE_RUN_LIMIT = 50

function monthlyLookbackRanges(months) {
  const ranges = []
  const now = new Date()
  for (let i = 0; i < months; i++) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1))
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    ranges.push({ minTimestamp: start.toISOString(), maxTimestamp: end.toISOString() })
  }
  return ranges
}

const SOLUTION_ALL_TIME_RANGE = {
  minTimestamp: monthlyLookbackRanges(SOLUTION_LOOKBACK_MONTHS).at(-1).minTimestamp,
  maxTimestamp: new Date().toISOString(),
}

/** Sums solution_agent_finished runs per ticket (reference_number) across the whole lookback
 * window, chunked by month to stay under Logfire's per-query row cap. */
async function fetchAllSolutionRunsByTicket(env) {
  const ranges = monthlyLookbackRanges(SOLUTION_LOOKBACK_MONTHS)
  const monthlyResults = await Promise.all(
    ranges.map((range) =>
      logfireQuery(
        `SELECT attributes->>'reference_number' as ticket, count(*) as runs, sum(COALESCE(CAST(attributes->>'duration_s' AS DOUBLE), 0)) as duration_sum, max(start_timestamp) as last_seen FROM records WHERE span_name = 'solution_agent_finished' AND deployment_environment = '${env}' AND attributes->>'reference_number' IS NOT NULL GROUP BY 1`,
        range,
      ),
    ),
  )
  const byTicket = new Map()
  for (const result of monthlyResults) {
    for (const row of result.data) {
      if (!row.ticket) continue
      const existing = byTicket.get(row.ticket) ?? { runs: 0, durationSum: 0, lastSeen: null }
      existing.runs += Number(row.runs ?? 0)
      existing.durationSum += Number(row.duration_sum ?? 0)
      if (!existing.lastSeen || row.last_seen > existing.lastSeen) existing.lastSeen = row.last_seen
      byTicket.set(row.ticket, existing)
    }
  }
  return byTicket
}

const DWH_BATCH_SIZE = 500

/** Looks up category/product/company/closed-time for a batch of reference numbers, chunked to
 * stay well under SQL Server's ~2100 parameter limit per query. */
async function fetchTicketMetaByReference(referenceNumbers) {
  const metaByRef = new Map()
  for (let i = 0; i < referenceNumbers.length; i += DWH_BATCH_SIZE) {
    const batch = referenceNumbers.slice(i, i + DWH_BATCH_SIZE)
    const rows = await dwhQuery(
      `SELECT reference_number, category_name, category_fullname, implementation_name, company_name, ticket_time_to_closed_sec FROM customer_inquiries.tickets_last_five_years WHERE reference_number IN (${batch.map((_, j) => `@ref${j}`).join(",")})`,
      batch.map((ref, j) => ({ name: `ref${j}`, type: sqlTypes.NVarChar, value: ref })),
    )
    for (const row of rows) {
      metaByRef.set(row.reference_number, {
        categoryName: row.category_name ?? null,
        categoryFullName: row.category_fullname ?? null,
        implementationName: row.implementation_name ?? null,
        companyName: row.company_name ?? null,
        closeDays: row.ticket_time_to_closed_sec != null ? Number(row.ticket_time_to_closed_sec) / 86400 : null,
      })
    }
  }
  return metaByRef
}

/** Looks up the ticket cluster each reference number belongs to (support.ticket_cluster_members),
 * chunked the same way as fetchTicketMetaByReference. Tickets outside any cluster are absent. */
async function fetchClusterIdByReference(referenceNumbers) {
  const clusterByRef = new Map()
  for (let i = 0; i < referenceNumbers.length; i += DWH_BATCH_SIZE) {
    const batch = referenceNumbers.slice(i, i + DWH_BATCH_SIZE)
    const rows = await dwhQuery(
      `SELECT reference_number, cluster_id FROM support.ticket_cluster_members WHERE reference_number IN (${batch.map((_, j) => `@ref${j}`).join(",")})`,
      batch.map((ref, j) => ({ name: `ref${j}`, type: sqlTypes.NVarChar, value: ref })),
    )
    for (const row of rows) clusterByRef.set(row.reference_number, row.cluster_id)
  }
  return clusterByRef
}

/** One row per ticket the solution agent has ever run against, with its DWH category/product/
 * company/cluster (falling back to "Ukjent" when the ticket isn't found in the DWH extract). */
async function buildSolutionAgentTickets(env) {
  const byTicket = await fetchAllSolutionRunsByTicket(env)
  const referenceNumbers = [...byTicket.keys()]
  const [metaByRef, clusterByRef] = await Promise.all([
    fetchTicketMetaByReference(referenceNumbers),
    fetchClusterIdByReference(referenceNumbers),
  ])

  return referenceNumbers.map((ref) => {
    const stats = byTicket.get(ref)
    const meta = metaByRef.get(ref)
    return {
      reference: ref,
      runs: stats.runs,
      avgDurationSec: stats.runs > 0 ? stats.durationSum / stats.runs : 0,
      lastSeen: stats.lastSeen,
      category: meta?.categoryFullName ?? meta?.categoryName ?? UNKNOWN_GROUP,
      product: meta?.implementationName ?? UNKNOWN_GROUP,
      company: meta?.companyName ?? UNKNOWN_GROUP,
      clusterId: clusterByRef.get(ref) ?? null,
      closeDays: meta?.closeDays ?? null,
    }
  })
}

/** Standard median (linear interpolation between the two middle values for an even count),
 * matching SQL Server's PERCENTILE_CONT(0.5) so the AI-side and DWH-side numbers agree. */
function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Groups tickets by a field, keeping the raw ticket list per group (used both for the group
 * summary aggregation below and for confidence sampling, which needs the actual reference numbers). */
function groupTicketsRaw(tickets, key) {
  const groups = new Map()
  for (const t of tickets) {
    const k = t[key] || UNKNOWN_GROUP
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(t)
  }
  return groups
}

function groupTicketsBy(tickets, key) {
  const raw = groupTicketsRaw(tickets, key)
  return [...raw.entries()]
    .map(([k, groupTickets]) => {
      const runCount = groupTickets.reduce((sum, t) => sum + t.runs, 0)
      const durationSum = groupTickets.reduce((sum, t) => sum + t.avgDurationSec * t.runs, 0)
      const closeDays = groupTickets.map((t) => t.closeDays).filter((d) => d != null)
      return {
        key: k,
        label: k,
        ticketCount: groupTickets.length,
        runCount,
        avgDurationSec: runCount > 0 ? durationSum / runCount : 0,
        medianCloseDaysAi: medianOf(closeDays),
      }
    })
    .sort((a, b) => b.ticketCount - a.ticketCount)
}

const SOLUTION_DIMENSIONS = { category: "category", product: "product", company: "company", cluster: "clusterId" }

// Confidence is parsed from free-text solution markdown (see parseConfidence below), so it can
// only be estimated from a sample of runs per group, not queried directly. This sample is smaller
// than SOLUTION_SAMPLE_RUN_LIMIT (used for the single-group detail modal) because it's taken once
// per group in a dimension - with dozens of groups, a 50-run sample per group would multiply into
// far too many Logfire round trips for a table that's supposed to load in a couple of seconds.
const SOLUTION_TABLE_SAMPLE_LIMIT = 15
// Keeps each fetchStepsByTrace call's response comfortably under Logfire's 1000-row cap, assuming
// a typical solution-agent trace produces well under 15 spans.
const STEPS_CHUNK_SIZE = 60

/** fetchStepsByTrace in one call, chunked to stay under Logfire's per-query row cap when sampling
 * confidence across many groups at once (see computeConfidenceForGroups). */
async function fetchStepsByTraceChunked(traceIds, range) {
  const stepsByTrace = new Map()
  const chunks = []
  for (let i = 0; i < traceIds.length; i += STEPS_CHUNK_SIZE) chunks.push(traceIds.slice(i, i + STEPS_CHUNK_SIZE))
  const results = await Promise.all(chunks.map((chunk) => fetchStepsByTrace(chunk, range)))
  for (const r of results) {
    for (const [traceId, steps] of r.stepsByTrace) stepsByTrace.set(traceId, steps)
  }
  return stepsByTrace
}

/** Estimates the confidence-level split for every group in a dimension from a bounded sample of
 * each group's most recent runs, in two batched passes (one query per group for sample trace ids,
 * then one shared chunked pass for all their steps) rather than one query per group per pass. */
async function computeConfidenceForGroups(env, groupsMap) {
  const entries = [...groupsMap.entries()]
  const sampleLists = await Promise.all(
    entries.map(([, groupTickets]) => {
      const refs = groupTickets.map((t) => t.reference)
      if (refs.length === 0) return Promise.resolve([])
      return logfireQuery(
        `SELECT trace_id FROM records WHERE span_name = 'solution_agent_finished' AND deployment_environment = '${env}' AND attributes->>'reference_number' IN (${sqlList(refs)}) ORDER BY start_timestamp DESC LIMIT ${SOLUTION_TABLE_SAMPLE_LIMIT}`,
        SOLUTION_ALL_TIME_RANGE,
      ).then((r) => r.data.map((row) => row.trace_id).filter((id) => TRACE_ID_RE.test(id)))
    }),
  )

  const stepsByTrace = await fetchStepsByTraceChunked(sampleLists.flat(), SOLUTION_ALL_TIME_RANGE)

  const result = new Map()
  entries.forEach(([key], i) => {
    const traceIds = sampleLists[i]
    const counts = { high: 0, medium: 0, low: 0, unknown: 0 }
    for (const traceId of traceIds) {
      const steps = stepsByTrace.get(traceId) ?? []
      const contentSteps = steps.filter((s) => s.type === "agent" || s.type === "chat")
      const solution = contentSteps.length > 0 ? contentSteps[contentSteps.length - 1].output : null
      counts[parseConfidence(solution) ?? "unknown"] += 1
    }
    const sampledRuns = traceIds.length
    result.set(key, {
      highPercent: sampledRuns > 0 ? (counts.high / sampledRuns) * 100 : null,
      mediumPercent: sampledRuns > 0 ? (counts.medium / sampledRuns) * 100 : null,
      sampledRuns,
    })
  })
  return result
}

/** Looks up display name + hierarchy for a batch of cluster ids (support.ticket_cluster_groups /
 * ticket_cluster_hierarchy), chunked like the reference-number lookups above. */
async function fetchClusterNames(clusterIds) {
  const namesByCluster = new Map()
  for (let i = 0; i < clusterIds.length; i += DWH_BATCH_SIZE) {
    const batch = clusterIds.slice(i, i + DWH_BATCH_SIZE)
    const rows = await dwhQuery(
      `SELECT cg.cluster_id, cg.label AS cluster_name, ch.hierarchy_name
       FROM support.ticket_cluster_groups cg
       LEFT JOIN support.ticket_cluster_hierarchy ch ON ch.cluster_id = cg.cluster_id
       WHERE cg.cluster_id IN (${batch.map((_, j) => `@c${j}`).join(",")})`,
      batch.map((id, j) => ({ name: `c${j}`, type: sqlTypes.Int, value: id })),
    )
    for (const row of rows) {
      namesByCluster.set(row.cluster_id, {
        clusterName: row.cluster_name ?? null,
        hierarchyName: row.hierarchy_name ?? null,
      })
    }
  }
  return namesByCluster
}

/** For each of the given clusters, counts tickets NOT touched by the solution agent and their
 * median time-to-closed, so the table can compare "AI-handled" vs. "everything else" per cluster
 * (mirrors the median_values/cluster_summary shape of the example DWH query, restricted to the
 * complement of our own reference-number set instead of an ad-hoc input list). */
async function fetchOtherClusterStats(clusterIds, aiReferenceNumbers) {
  // reference_number is always a plain digit string here (sourced from Logfire attributes, never
  // user input) - validated before being inlined as a literal, since there are too many of them to
  // pass as individually bound parameters.
  const validRefs = aiReferenceNumbers.filter((r) => /^\d+$/.test(r))
  const excludeList = validRefs.length > 0 ? sqlList(validRefs) : "''"
  const statsByCluster = new Map()
  for (let i = 0; i < clusterIds.length; i += DWH_BATCH_SIZE) {
    const batch = clusterIds.slice(i, i + DWH_BATCH_SIZE)
    const rows = await dwhQuery(
      `WITH other_tickets AS (
        SELECT DISTINCT m.reference_number, m.cluster_id
        FROM support.ticket_cluster_members m
        WHERE m.cluster_id IN (${batch.map((_, j) => `@c${j}`).join(",")})
          AND m.reference_number NOT IN (${excludeList})
      ),
      ticket_data AS (
        SELECT ot.cluster_id, ot.reference_number, t.ticket_time_to_closed_sec
        FROM other_tickets ot
        LEFT JOIN customer_inquiries.tickets_last_five_years t ON t.reference_number = ot.reference_number
      ),
      median_values AS (
        SELECT DISTINCT cluster_id,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ticket_time_to_closed_sec) OVER (PARTITION BY cluster_id) AS median_close_seconds
        FROM ticket_data
        WHERE ticket_time_to_closed_sec IS NOT NULL
      )
      SELECT
        td.cluster_id,
        COUNT(DISTINCT td.reference_number) AS other_ticket_count,
        CAST(MAX(mv.median_close_seconds) / 86400.0 AS decimal(10,2)) AS median_close_days_other
      FROM ticket_data td
      LEFT JOIN median_values mv ON mv.cluster_id = td.cluster_id
      GROUP BY td.cluster_id`,
      batch.map((id, j) => ({ name: `c${j}`, type: sqlTypes.Int, value: id })),
    )
    for (const row of rows) {
      statsByCluster.set(row.cluster_id, {
        otherTicketCount: Number(row.other_ticket_count ?? 0),
        medianCloseDaysOther: row.median_close_days_other != null ? Number(row.median_close_days_other) : null,
      })
    }
  }
  return statsByCluster
}

/** Enriches the raw clusterId-keyed groups with display name/hierarchy and "rest of cluster"
 * stats from the DWH. Tickets with no cluster membership stay grouped under UNKNOWN_GROUP. */
async function enrichClusterGroups(byClusterRaw, allReferenceNumbers) {
  const clusterIds = byClusterRaw.map((g) => g.key).filter((k) => k !== UNKNOWN_GROUP).map(Number)
  const [namesByCluster, otherStatsByCluster] = await Promise.all([
    fetchClusterNames(clusterIds),
    fetchOtherClusterStats(clusterIds, allReferenceNumbers),
  ])
  return byClusterRaw.map((g) => {
    if (g.key === UNKNOWN_GROUP) {
      return { ...g, label: "Ukjent klynge", hierarchyName: null, otherTicketCount: 0, totalTicketCount: g.ticketCount, medianCloseDaysOther: null }
    }
    const clusterId = Number(g.key)
    const names = namesByCluster.get(clusterId)
    const other = otherStatsByCluster.get(clusterId)
    return {
      ...g,
      label: names?.clusterName ?? `Klynge ${clusterId}`,
      hierarchyName: names?.hierarchyName ?? null,
      otherTicketCount: other?.otherTicketCount ?? 0,
      totalTicketCount: g.ticketCount + (other?.otherTicketCount ?? 0),
      medianCloseDaysOther: other?.medianCloseDaysOther ?? null,
    }
  })
}

// Matches "**Konfidens** · MEDIUM" (or "HØY"/"LAV", with either "·" or ":" as separator) in the
// solution agent's final markdown output - confidence isn't a separate logged attribute, it's
// embedded in this free-text field, so it has to be parsed out rather than queried directly.
const CONFIDENCE_RE = /\*\*Konfidens\*\*\s*[·:-]\s*(HØY|MEDIUM|LAV)/i
const CONFIDENCE_LABELS = { "høy": "high", medium: "medium", lav: "low" }

function parseConfidence(solutionText) {
  if (!solutionText) return null
  const m = solutionText.match(CONFIDENCE_RE)
  if (!m) return null
  return CONFIDENCE_LABELS[m[1].toLowerCase()] ?? null
}

// Sources are listed under a trailing "## Kilder" section as "[1] [Title](url) — ..." lines,
// and referenced inline in the steps above as "[[1]](url)" - same free-text-only situation as
// confidence, so they're parsed out of the solution markdown rather than queried directly.
function parseSources(solutionText) {
  if (!solutionText) return []
  const section = solutionText.match(/##\s*Kilder\s*\n([\s\S]*)/i)
  if (!section) return []
  const sources = []
  const lineRe = /\[\d+\]\s*\[([^\]]+)\]\(([^)]+)\)/g
  let m
  while ((m = lineRe.exec(section[1]))) {
    sources.push({ title: m[1], url: m[2] })
  }
  return sources
}

/** Groups ungrouped solution_agent_finished rows into one entry per ticket, newest run first. */
function groupRunsByTicket(runRows) {
  const byTicket = new Map()
  for (const row of runRows) {
    const ticket = row.ticket
    if (!ticket) continue
    if (!byTicket.has(ticket)) byTicket.set(ticket, [])
    byTicket.get(ticket).push(row)
  }
  return [...byTicket.entries()]
    .map(([ticket, runs]) => ({
      ticket,
      lastSeen: runs[0].start_timestamp,
      runs,
    }))
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
}

app.get("/api/dashboard", async (req, res) => {
  try {
    const env = resolveEnv(req)
    const range = resolveTimeRange(req)
    const [
      responseTimeResult,
      tokensCostResult,
      usageTodayResult,
      contextResult,
      dailyUsersResult,
      errorsTotalResult,
      errorKindsResult,
      toolFailuresResult,
      securityJudgeResult,
      usageResult,
      usageErrorsResult,
      toolsResult,
      llmCallsResult,
      modelsResult,
      solutionRunsResult,
      dailyCostResult,
      dailyUsageByContextResult,
      dailyUserIdsResult,
      dailyErrorsByKindResult,
      dailyToolFailuresByToolResult,
      dailySecurityJudgeByKindResult,
      allEntitiesLatestResult,
      dailyNoAnswerResult,
    ] = await Promise.all([
      logfireQuery(
        `SELECT approx_percentile_cont(duration, 0.5) as median_dur, avg(duration) as avg_dur FROM records WHERE attributes->>'gen_ai.operation.name' = 'invoke_agent' AND deployment_environment = '${env}' AND trace_id NOT IN (SELECT DISTINCT trace_id FROM records WHERE span_name = 'solution_agent_finished' AND deployment_environment = '${env}')`,
        range,
      ),
      logfireQuery(
        `SELECT sum(COALESCE(CAST(attributes->>'gen_ai.usage.input_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.input_tokens' AS BIGINT)) + COALESCE(CAST(attributes->>'gen_ai.usage.output_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.output_tokens' AS BIGINT))) as total_tokens, sum(CAST(attributes->>'gen_ai.aggregated_usage.cache_read.input_tokens' AS BIGINT)) as cached_tokens, sum(CAST(attributes->'logfire.metrics'->'operation.cost'->>'total' AS DOUBLE)) as cost_usd FROM records WHERE attributes->>'gen_ai.operation.name' = 'invoke_agent' AND deployment_environment = '${env}'`,
        range,
      ),
      logfireQuery(
        `SELECT count(distinct attributes->>'anon_user_id') as users, count(*) as uses FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}'`,
        range,
      ),
      logfireQuery(
        `SELECT COALESCE(attributes->'context'->>'entity_type', 'none') as entity_type, count(*) as n FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY n DESC`,
        range,
      ),
      logfireQuery(
        `SELECT date_trunc('day', start_timestamp) as day, count(distinct attributes->>'anon_user_id') as users, count(*) as messages FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY 1`,
        range,
      ),
      logfireQuery(`SELECT count(*) as n FROM records WHERE level >= 17 AND deployment_environment = '${env}'`, range),
      logfireQuery(
        `SELECT COALESCE(exception_type, attributes->>'logfire.msg_template', span_name) as kind, count(*) as n FROM records WHERE level >= 17 AND deployment_environment = '${env}' GROUP BY 1 ORDER BY n DESC LIMIT 6`,
        range,
      ),
      logfireQuery(
        `SELECT category, tool, count(*) as n FROM (
          SELECT 'agent' as category, attributes->'logfire.logging_args'->>0 as tool FROM records
            WHERE level >= 17 AND deployment_environment = '${env}'
            AND attributes->>'logfire.msg_template' IN (${AGENT_TOOL_FAILURE_TEMPLATE_LIST})
          UNION ALL
          SELECT 'direct' as category, attributes->'logfire.logging_args'->>1 as tool FROM records
            WHERE level >= 17 AND deployment_environment = '${env}'
            AND attributes->>'logfire.msg_template' IN (${DIRECT_TOOL_FAILURE_TEMPLATE_LIST})
        ) GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`,
        range,
      ),
      logfireQuery(
        `SELECT span_name, count(*) as n FROM records WHERE span_name IN (${SECURITY_JUDGE_SPAN_LIST}) AND deployment_environment = '${env}' GROUP BY 1 ORDER BY n DESC`,
        range,
      ),
      logfireQuery(
        `SELECT entity_type, entity_id, trace_id, n, last_seen, model, reasoning_effort FROM (
          SELECT
            COALESCE(attributes->'context'->>'entity_type', 'none') as entity_type,
            attributes->'context'->>'entity_id' as entity_id,
            trace_id,
            attributes->>'model' as model,
            attributes->>'reasoning_effort' as reasoning_effort,
            start_timestamp,
            COUNT(*) OVER (PARTITION BY COALESCE(attributes->'context'->>'entity_type', 'none'), attributes->'context'->>'entity_id') as n,
            MAX(start_timestamp) OVER (PARTITION BY COALESCE(attributes->'context'->>'entity_type', 'none'), attributes->'context'->>'entity_id') as last_seen,
            ROW_NUMBER() OVER (PARTITION BY COALESCE(attributes->'context'->>'entity_type', 'none'), attributes->'context'->>'entity_id' ORDER BY start_timestamp DESC) as rn
          FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}'
        ) WHERE rn = 1 ORDER BY last_seen DESC LIMIT 1000`,
        range,
      ),
      logfireQuery(
        `SELECT COALESCE(attributes->'context'->>'entity_type', 'none') as entity_type, attributes->'context'->>'entity_id' as entity_id, count(distinct trace_id) as error_requests
        FROM records
        WHERE span_name = 'chat.request' AND deployment_environment = '${env}'
        AND trace_id IN (SELECT DISTINCT trace_id FROM records WHERE level >= 17 AND deployment_environment = '${env}')
        GROUP BY 1, 2`,
        range,
      ),
      logfireQuery(
        `SELECT substring(span_name, 12) as tool, count(*) as calls, sum(duration) as total_duration, avg(duration) as avg_duration, sum(CASE WHEN level >= 17 THEN 1 ELSE 0 END) as errors FROM records WHERE span_name LIKE 'tools/call %' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY total_duration DESC`,
        range,
      ),
      logfireQuery(
        `SELECT attributes->>'model_name' as model, sum(COALESCE(CAST(attributes->>'gen_ai.usage.input_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.input_tokens' AS BIGINT))) as input_tokens, sum(COALESCE(CAST(attributes->>'gen_ai.usage.output_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.output_tokens' AS BIGINT))) as output_tokens, sum(CAST(attributes->'logfire.metrics'->'operation.cost'->>'total' AS DOUBLE)) as cost_usd, count(*) as calls FROM records WHERE attributes->>'gen_ai.operation.name' = 'invoke_agent' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY calls DESC LIMIT 8`,
        range,
      ),
      logfireQuery(
        `SELECT substring(span_name, 6) as model, count(*) as calls, sum(COALESCE(CAST(attributes->>'gen_ai.usage.input_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.input_tokens' AS BIGINT), 0)) as input_tokens, sum(COALESCE(CAST(attributes->>'gen_ai.usage.output_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.output_tokens' AS BIGINT), 0)) as output_tokens, sum(duration) as total_duration FROM records WHERE span_name LIKE 'chat %' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY (input_tokens + output_tokens) DESC`,
        range,
      ),
      logfireQuery(
        `SELECT trace_id, start_timestamp, attributes->>'reference_number' as ticket, attributes->>'outcome' as outcome, CAST(attributes->>'duration_s' AS DOUBLE) as duration_s FROM records WHERE span_name = 'solution_agent_finished' AND deployment_environment = '${env}' ORDER BY start_timestamp DESC LIMIT 200`,
        range,
      ),
      logfireQuery(
        `SELECT date_trunc('day', start_timestamp) as day, sum(CAST(attributes->'logfire.metrics'->'operation.cost'->>'total' AS DOUBLE)) as cost FROM records WHERE attributes->>'gen_ai.operation.name' = 'invoke_agent' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY 1`,
        range,
      ),
      logfireQuery(
        `SELECT date_trunc('day', start_timestamp) as day, COALESCE(attributes->'context'->>'entity_type', 'none') as entity_type, count(*) as n FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}' GROUP BY 1, 2 ORDER BY 1`,
        range,
      ),
      logfireQuery(
        `SELECT date_trunc('day', start_timestamp) as day, attributes->>'anon_user_id' as user_id FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}' AND attributes->>'anon_user_id' IS NOT NULL GROUP BY 1, 2 ORDER BY 1`,
        range,
      ),
      logfireQuery(
        `SELECT date_trunc('day', start_timestamp) as day, COALESCE(exception_type, attributes->>'logfire.msg_template', span_name) as kind, count(*) as n FROM records WHERE level >= 17 AND deployment_environment = '${env}' GROUP BY 1, 2 ORDER BY 1`,
        range,
      ),
      logfireQuery(
        `SELECT day, tool, sum(n) as n FROM (
          SELECT date_trunc('day', start_timestamp) as day, attributes->'logfire.logging_args'->>0 as tool, count(*) as n FROM records
            WHERE level >= 17 AND deployment_environment = '${env}'
            AND attributes->>'logfire.msg_template' IN (${AGENT_TOOL_FAILURE_TEMPLATE_LIST})
            GROUP BY 1, 2
          UNION ALL
          SELECT date_trunc('day', start_timestamp) as day, attributes->'logfire.logging_args'->>1 as tool, count(*) as n FROM records
            WHERE level >= 17 AND deployment_environment = '${env}'
            AND attributes->>'logfire.msg_template' IN (${DIRECT_TOOL_FAILURE_TEMPLATE_LIST})
            GROUP BY 1, 2
        ) GROUP BY 1, 2 ORDER BY 1`,
        range,
      ),
      logfireQuery(
        `SELECT date_trunc('day', start_timestamp) as day, span_name, count(*) as n FROM records WHERE span_name IN (${SECURITY_JUDGE_SPAN_LIST}) AND deployment_environment = '${env}' GROUP BY 1, 2 ORDER BY 1`,
        range,
      ),
      // Separate from usageResult (the conversation-log table), so the failed-responses rate below
      // isn't tied to whatever cap that table happens to use for display purposes.
      logfireQuery(
        `SELECT entity_type, entity_id, trace_id FROM (
          SELECT
            COALESCE(attributes->'context'->>'entity_type', 'none') as entity_type,
            attributes->'context'->>'entity_id' as entity_id,
            trace_id,
            start_timestamp,
            ROW_NUMBER() OVER (PARTITION BY COALESCE(attributes->'context'->>'entity_type', 'none'), COALESCE(attributes->'context'->>'entity_id', '0') ORDER BY start_timestamp DESC) as rn
          FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}'
        ) WHERE rn = 1 LIMIT 1000`,
        range,
      ),
      // Daily failed-response rate for the trend chart, aggregated in SQL so the per-day counts
      // aren't silently capped by the query API's 1000-row response ceiling once a range holds
      // more than 1000 chat.request spans (that previously made single days look far worse or
      // better than they actually were, since rows were returned with no ORDER BY to guarantee
      // an even spread across days).
      logfireQuery(
        `SELECT date_trunc('day', r.start_timestamp) as day,
          count(DISTINCT r.trace_id) as total,
          count(DISTINCT CASE WHEN a.trace_id IS NULL THEN r.trace_id END) as no_answer
        FROM records r
        LEFT JOIN (SELECT DISTINCT trace_id FROM records WHERE deployment_environment = '${env}' AND ${ANSWERED_CONDITION_SQL}) a ON a.trace_id = r.trace_id
        WHERE r.span_name = 'chat.request' AND r.deployment_environment = '${env}'
        GROUP BY 1 ORDER BY 1`,
        range,
      ),
    ])

    // Headline failed-responses rate: every entity's latest chat.request in range (not just the
    // 100 shown in the conversation-log table), so it reflects the whole selected time range.
    const allEntityTraceIds = allEntitiesLatestResult.data.map((r) => r.trace_id).filter((id) => TRACE_ID_RE.test(id))
    const answeredTracesResult = await logfireQuery(
      `SELECT DISTINCT trace_id FROM records WHERE trace_id IN (${sqlList(allEntityTraceIds)}) AND deployment_environment = '${env}' AND ${ANSWERED_CONDITION_SQL}`,
      range,
    )
    const answeredTraces = new Set(answeredTracesResult.data.map((r) => r.trace_id))
    const noAnswerByEntity = new Map()
    for (const row of allEntitiesLatestResult.data) {
      const entityId = row.entity_id && row.entity_id !== "0" ? row.entity_id : null
      const key = `${row.entity_type}-${entityId ?? "none"}`
      noAnswerByEntity.set(key, answeredTraces.has(row.trace_id) ? 0 : 1)
    }
    const noAnswerCount = [...noAnswerByEntity.values()].filter((v) => v === 1).length
    const totalEntities = allEntitiesLatestResult.data.length
    const noAnswerPercent = totalEntities > 0 ? (noAnswerCount / totalEntities) * 100 : 0

    const allTickets = groupRunsByTicket(solutionRunsResult.data)
    const detailedTickets = allTickets.slice(0, 15)
    const traceIds = [
      ...new Set(
        detailedTickets.flatMap((t) => t.runs.map((r) => r.trace_id)).filter((id) => TRACE_ID_RE.test(id)),
      ),
    ]

    const { stepsByTrace } = await fetchStepsByTrace(traceIds, range)

    /** Per-ticket solution-agent stats, keyed by reference number. Full step detail (and
     * therefore cost, which lives on nested spans) is only available for `detailedTickets`. */
    const solutionByTicket = new Map()
    for (const t of allTickets) {
      const runs = t.runs.map((r) => {
        const steps = stepsByTrace.get(r.trace_id)
        if (!steps) {
          return {
            traceId: r.trace_id,
            timestamp: r.start_timestamp,
            outcome: r.outcome ?? "unknown",
            durationSec: r.duration_s ?? 0,
            steps: [],
            solution: null,
            costUsd: null,
            failureReason: null,
          }
        }
        const agentSteps = steps.filter((s) => s.type === "agent" && s.output)
        const solution = agentSteps.length > 0 ? agentSteps[agentSteps.length - 1].output : null
        const costUsd = steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
        const failedStep = steps.find((s) => s.isError)
        return {
          traceId: r.trace_id,
          timestamp: r.start_timestamp,
          outcome: r.outcome ?? "unknown",
          durationSec: r.duration_s ?? 0,
          steps,
          solution,
          costUsd,
          failureReason: failedStep?.label ?? null,
        }
      })
      const knownCosts = runs.filter((r) => r.costUsd != null)
      solutionByTicket.set(t.ticket, {
        triggers: runs.length,
        lastSeen: t.lastSeen,
        exceptions: t.runs.filter((r) => r.outcome === "exception").length,
        avgDurationSec: t.runs.reduce((sum, r) => sum + (r.duration_s ?? 0), 0) / t.runs.length,
        costUsd: knownCosts.length > 0 ? knownCosts.reduce((sum, r) => sum + r.costUsd, 0) : null,
        runs,
      })
    }

    const responseTimeRow = responseTimeResult.data[0] ?? { median_dur: 0, avg_dur: 0 }
    const tokensCostRow = tokensCostResult.data[0] ?? { total_tokens: 0, cached_tokens: 0, cost_usd: 0 }
    const usageTodayRow = usageTodayResult.data[0] ?? { users: 0, uses: 0 }

    const solutionDurations = solutionRunsResult.data
      .map((row) => row.duration_s)
      .filter((d) => typeof d === "number" && !Number.isNaN(d))
      .sort((a, b) => a - b)
    const solutionMedianResponseTimeSec =
      solutionDurations.length > 0 ? solutionDurations[Math.floor(solutionDurations.length / 2)] : 0

    const errorCountByEntity = new Map()
    for (const row of usageErrorsResult.data) {
      const entityId = row.entity_id && row.entity_id !== "0" ? row.entity_id : null
      errorCountByEntity.set(`${row.entity_type}-${entityId ?? "none"}`, Number(row.error_requests ?? 0))
    }

    res.json({
      totals: {
        medianResponseTimeSec: Number(responseTimeRow.median_dur ?? 0),
        avgResponseTimeSec: Number(responseTimeRow.avg_dur ?? 0),
        solutionMedianResponseTimeSec: Number(solutionMedianResponseTimeSec ?? 0),
        tokensUsed: Number(tokensCostRow.total_tokens ?? 0),
        cachedTokens: Number(tokensCostRow.cached_tokens ?? 0),
        costUsd: Number(tokensCostRow.cost_usd ?? 0),
        uniqueUsers: Number(usageTodayRow.users ?? 0),
        uses: Number(usageTodayRow.uses ?? 0),
        noAnswerCount,
        noAnswerPercent,
        totalEntities,
      },
      context: contextResult.data.map((row) => ({ type: row.entity_type, count: Number(row.n ?? 0) })),
      dailyUsers: (() => {
        const userIdsByDay = new Map()
        for (const row of dailyUserIdsResult.data) {
          if (!userIdsByDay.has(row.day)) userIdsByDay.set(row.day, new Set())
          userIdsByDay.get(row.day).add(row.user_id)
        }
        const seenUsers = new Set()
        return dailyUsersResult.data.map((row) => {
          const dayUsers = userIdsByDay.get(row.day) ?? new Set()
          for (const u of dayUsers) seenUsers.add(u)
          return {
            day: row.day,
            users: Number(row.users ?? 0),
            messages: Number(row.messages ?? 0),
            cumulativeUsers: seenUsers.size,
          }
        })
      })(),
      errors: {
        total: Number(errorsTotalResult.data[0]?.n ?? 0),
        byKind: errorKindsResult.data
          .filter((row) => row.kind)
          .map((row) => ({ kind: row.kind, count: Number(row.n ?? 0) })),
      },
      toolFailures: toolFailuresResult.data
        .filter((row) => row.tool)
        .map((row) => ({ tool: row.tool, category: row.category, count: Number(row.n ?? 0) })),
      securityJudge: {
        total: securityJudgeResult.data.reduce((sum, row) => sum + Number(row.n ?? 0), 0),
        byKind: securityJudgeResult.data.map((row) => ({
          kind: SECURITY_JUDGE_LABELS[row.span_name] ?? row.span_name,
          count: Number(row.n ?? 0),
        })),
      },
      tools: toolsResult.data
        .filter((row) => row.tool)
        .map((row) => ({
          tool: row.tool,
          calls: Number(row.calls ?? 0),
          totalDurationSec: Number(row.total_duration ?? 0),
          avgDurationSec: Number(row.avg_duration ?? 0),
          errors: Number(row.errors ?? 0),
        })),
      llmCalls: llmCallsResult.data
        .filter((row) => row.model)
        .map((row) => ({
          model: row.model,
          calls: Number(row.calls ?? 0),
          inputTokens: Number(row.input_tokens ?? 0),
          outputTokens: Number(row.output_tokens ?? 0),
          totalDurationSec: Number(row.total_duration ?? 0),
        })),
      models: modelsResult.data
        .filter((row) => row.model)
        .map((row) => ({
          model: row.model,
          inputTokens: Number(row.input_tokens ?? 0),
          outputTokens: Number(row.output_tokens ?? 0),
          costUsd: row.cost_usd != null ? Number(row.cost_usd) : null,
          calls: Number(row.calls ?? 0),
        })),
      usage: usageResult.data.map((row) => {
        const entityType = row.entity_type
        const entityId = row.entity_id && row.entity_id !== "0" ? row.entity_id : null
        const solution = entityType === "ticket" && entityId ? solutionByTicket.get(entityId) : null
        return {
          entityType,
          entityId,
          uses: Number(row.n ?? 0),
          lastSeen: row.last_seen,
          model: row.model ?? null,
          reasoningEffort: row.reasoning_effort && row.reasoning_effort !== "none" ? row.reasoning_effort : null,
          triggers: solution?.triggers ?? 0,
          avgDurationSec: solution?.avgDurationSec ?? 0,
          costUsd: solution?.costUsd ?? null,
          exceptions: solution?.exceptions ?? 0,
          errorCount: errorCountByEntity.get(`${entityType}-${entityId ?? "none"}`) ?? 0,
          noAnswerCount: noAnswerByEntity.get(`${entityType}-${entityId ?? "none"}`) ?? 0,
          runs: solution?.runs ?? [],
        }
      }),
      dailyCost: (() => {
        let cumulative = 0
        return dailyCostResult.data.map((row) => {
          const cost = Number(row.cost ?? 0)
          cumulative += cost
          return { day: row.day, cost, cumulativeCost: cumulative }
        })
      })(),
      dailyUsageByContext: dailyUsageByContextResult.data.map((row) => ({
        day: row.day,
        type: row.entity_type,
        count: Number(row.n ?? 0),
      })),
      dailyErrorsByKind: (() => {
        const topKinds = new Set(errorKindsResult.data.map((r) => r.kind))
        return dailyErrorsByKindResult.data
          .filter((row) => topKinds.has(row.kind))
          .map((row) => ({ day: row.day, kind: row.kind, count: Number(row.n ?? 0) }))
      })(),
      dailyToolFailures: (() => {
        const topTools = new Set(toolFailuresResult.data.map((r) => r.tool))
        return dailyToolFailuresByToolResult.data
          .filter((row) => row.tool && topTools.has(row.tool))
          .map((row) => ({ day: row.day, tool: row.tool, count: Number(row.n ?? 0) }))
      })(),
      dailySecurityJudge: dailySecurityJudgeByKindResult.data.map((row) => ({
        day: row.day,
        kind: SECURITY_JUDGE_LABELS[row.span_name] ?? row.span_name,
        count: Number(row.n ?? 0),
      })),
      dailyNoAnswer: dailyNoAnswerResult.data.map((row) => {
        const total = Number(row.total ?? 0)
        const noAnswer = Number(row.no_answer ?? 0)
        return { day: row.day, total, noAnswer, percent: total > 0 ? (noAnswer / total) * 100 : 0 }
      }),
    })
  } catch (e) {
    console.error("[logfire] dashboard query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/errors/:kind", async (req, res) => {
  try {
    const env = resolveEnv(req)
    const kind = req.params.kind.replace(/'/g, "''")
    const range = resolveTimeRange(req)
    const result = await logfireQuery(
      `SELECT trace_id, start_timestamp, service_name, message, exception_message, exception_type FROM records WHERE level >= 17 AND deployment_environment = '${env}' AND COALESCE(exception_type, attributes->>'logfire.msg_template', span_name) = '${kind}' ORDER BY start_timestamp DESC LIMIT 15`,
      range,
    )
    const { modelByTrace, ticketByTrace } = await fetchTraceContext(
      result.data.map((row) => row.trace_id),
      range,
    )
    res.json({
      examples: result.data.map((row) => ({
        time: row.start_timestamp,
        service: row.service_name ?? "unknown",
        message: row.exception_message || row.message || "",
        exceptionType: row.exception_type ?? null,
        model: modelByTrace.get(row.trace_id) ?? null,
        ticketId: ticketByTrace.get(row.trace_id) ?? null,
      })),
    })
  } catch (e) {
    console.error("[logfire] error examples query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/tool-failures/:tool", async (req, res) => {
  try {
    const env = resolveEnv(req)
    const tool = req.params.tool.replace(/'/g, "''")
    const category = req.query.category === "direct" ? "direct" : "agent"
    const templateList = category === "direct" ? DIRECT_TOOL_FAILURE_TEMPLATE_LIST : AGENT_TOOL_FAILURE_TEMPLATE_LIST
    const toolArgIndex = category === "direct" ? 1 : 0
    const detailArgIndex = category === "direct" ? 2 : 1
    const range = resolveTimeRange(req)
    const result = await logfireQuery(
      `SELECT trace_id, start_timestamp, attributes->>'logfire.msg_template' as template, attributes->'logfire.logging_args'->>${detailArgIndex} as detail FROM records WHERE level >= 17 AND deployment_environment = '${env}' AND attributes->>'logfire.msg_template' IN (${templateList}) AND attributes->'logfire.logging_args'->>${toolArgIndex} = '${tool}' ORDER BY start_timestamp DESC LIMIT 15`,
      range,
    )
    const { modelByTrace, ticketByTrace } = await fetchTraceContext(
      result.data.map((row) => row.trace_id),
      range,
    )
    res.json({
      examples: result.data.map((row) => ({
        time: row.start_timestamp,
        kind: row.template?.includes("timed out") ? "timeout" : "exception",
        detail: row.template?.includes("timed out") ? `Timed out after ${row.detail}s` : row.detail ?? "",
        model: modelByTrace.get(row.trace_id) ?? null,
        ticketId: ticketByTrace.get(row.trace_id) ?? null,
      })),
    })
  } catch (e) {
    console.error("[logfire] tool failure examples query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/security-judge/:kind", async (req, res) => {
  try {
    const env = resolveEnv(req)
    const spanName = SECURITY_JUDGE_KINDS[req.params.kind]
    if (!spanName) return res.status(404).json({ error: "unknown kind" })
    const range = resolveTimeRange(req)
    const result = await logfireQuery(
      `SELECT trace_id, start_timestamp, attributes->>'flagged_content' as flagged_content, attributes->'logfire.logging_args'->>0 as tool_name FROM records WHERE span_name = '${spanName.replace(/'/g, "''")}' AND deployment_environment = '${env}' ORDER BY start_timestamp DESC LIMIT 15`,
      range,
    )
    const { ticketByTrace } = await fetchTraceContext(
      result.data.map((row) => row.trace_id),
      range,
    )
    res.json({
      examples: result.data.map((row) => {
        const content = row.flagged_content ?? (row.tool_name ? `Tool: ${row.tool_name}` : "")
        return {
          time: row.start_timestamp,
          ticketId: ticketByTrace.get(row.trace_id) ?? null,
          detail: content.length > 300 ? `${content.slice(0, 300)}…` : content,
        }
      }),
    })
  } catch (e) {
    console.error("[logfire] security judge examples query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/usage-runs", async (req, res) => {
  try {
    const env = resolveEnv(req)
    const entityType = String(req.query.entityType ?? "none").replace(/'/g, "''")
    const entityIdRaw = req.query.entityId
    const entityId = entityIdRaw && entityIdRaw !== "null" ? String(entityIdRaw).replace(/'/g, "''") : null
    const range = resolveTimeRange(req)

    const entityIdFilter = entityId
      ? `attributes->'context'->>'entity_id' = '${entityId}'`
      : `attributes->'context'->>'entity_id' IS NULL`

    const requestsResult = await logfireQuery(
      `SELECT trace_id, start_timestamp, duration FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}' AND COALESCE(attributes->'context'->>'entity_type', 'none') = '${entityType}' AND ${entityIdFilter} ORDER BY start_timestamp DESC LIMIT 1000`,
      range,
    )

    const traceIds = requestsResult.data.map((r) => r.trace_id).filter((id) => TRACE_ID_RE.test(id))
    const { stepsByTrace, exceptionTraces } = await fetchStepsByTrace(traceIds, range)

    const runs = requestsResult.data.map((row) => {
      const steps = stepsByTrace.get(row.trace_id) ?? []
      const outputSteps = steps.filter((s) => (s.type === "agent" || s.type === "chat") && s.output)
      const solution = outputSteps.length > 0 ? outputSteps[outputSteps.length - 1].output : null
      const costUsd = steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
      const failedStep = steps.find((s) => s.isError)

      const contentSteps = steps.filter((s) => s.type === "agent" || s.type === "chat")
      const lastContentStep = contentSteps.length > 0 ? contentSteps[contentSteps.length - 1] : null
      const hasNoAnswer = !lastContentStep || !lastContentStep.output

      return {
        traceId: row.trace_id,
        timestamp: row.start_timestamp,
        outcome: exceptionTraces.has(row.trace_id) ? "exception" : "completed",
        durationSec: row.duration ?? 0,
        steps,
        solution,
        costUsd: costUsd > 0 ? costUsd : null,
        failureReason: failedStep?.label ?? null,
        hasNoAnswer,
      }
    })

    res.json({ runs })
  } catch (e) {
    console.error("[logfire] usage runs query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/no-answer", async (req, res) => {
  try {
    const env = resolveEnv(req)
    const range = resolveTimeRange(req)

    const requestsResult = await logfireQuery(
      `SELECT trace_id, start_timestamp, duration, COALESCE(attributes->'context'->>'entity_type', 'none') as entity_type, attributes->'context'->>'entity_id' as entity_id FROM (SELECT trace_id, start_timestamp, duration, attributes, ROW_NUMBER() OVER (PARTITION BY COALESCE(attributes->'context'->>'entity_type', 'none'), COALESCE(attributes->'context'->>'entity_id', '0') ORDER BY start_timestamp DESC) as rn FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}') sub WHERE rn = 1 ORDER BY start_timestamp DESC`,
      range,
    )

    const traceIds = requestsResult.data.map((r) => r.trace_id).filter((id) => TRACE_ID_RE.test(id))
    const answeredResult = await logfireQuery(
      `SELECT DISTINCT trace_id FROM records WHERE trace_id IN (${sqlList(traceIds)}) AND deployment_environment = '${env}' AND ${ANSWERED_CONDITION_SQL}`,
      range,
    )
    const answeredTraces = new Set(answeredResult.data.map((r) => r.trace_id))

    const noAnswerRows = requestsResult.data.filter((row) => !answeredTraces.has(row.trace_id))

    const { stepsByTrace, exceptionTraces } = await fetchStepsByTrace(
      noAnswerRows.map((r) => r.trace_id).filter((id) => TRACE_ID_RE.test(id)),
      range,
    )
    const { modelByTrace, ticketByTrace } = await fetchTraceContext(
      noAnswerRows.map((r) => r.trace_id).filter((id) => TRACE_ID_RE.test(id)),
      range,
    )

    const SECURITY_LABELS = Object.values(SECURITY_JUDGE_KINDS)

    const examples = noAnswerRows.map((row) => {
      const steps = stepsByTrace.get(row.trace_id) ?? []
      const contentSteps = steps.filter((s) => s.type === "agent" || s.type === "chat")
      const lastContentStep = contentSteps.length > 0 ? contentSteps[contentSteps.length - 1] : null

      let reason
      if (contentSteps.length === 0) {
        const judgeStep = steps.find((s) => SECURITY_LABELS.some((l) => s.label.includes(l)) || s.label.includes("LLM Judge"))
        reason = judgeStep ? `Blocked by security judge` : "No LLM response generated"
      } else if (exceptionTraces.has(row.trace_id)) {
        const failedStep = steps.find((s) => s.isError)
        reason = failedStep ? `Exception: ${failedStep.label}` : "Exception during execution"
      } else {
        reason = `Empty response from ${lastContentStep.label}`
      }

      return {
        time: row.start_timestamp,
        traceId: row.trace_id,
        durationSec: row.duration ?? 0,
        reason,
        model: modelByTrace.get(row.trace_id) ?? null,
        ticketId: ticketByTrace.get(row.trace_id) ?? null,
      }
    })

    res.json({ examples })
  } catch (e) {
    console.error("[logfire] no-answer query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/usage-errors", async (req, res) => {
  try {
    const env = resolveEnv(req)
    const entityType = String(req.query.entityType ?? "none").replace(/'/g, "''")
    const entityIdRaw = req.query.entityId
    const entityId = entityIdRaw && entityIdRaw !== "null" ? String(entityIdRaw).replace(/'/g, "''") : null
    const range = resolveTimeRange(req)

    const entityIdFilter = entityId
      ? `attributes->'context'->>'entity_id' = '${entityId}'`
      : `attributes->'context'->>'entity_id' IS NULL`

    const result = await logfireQuery(
      `SELECT start_timestamp, message, exception_message, exception_type, span_name FROM records
       WHERE level >= 17 AND deployment_environment = '${env}'
       AND trace_id IN (
         SELECT trace_id FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}'
         AND COALESCE(attributes->'context'->>'entity_type', 'none') = '${entityType}' AND ${entityIdFilter}
       )
       ORDER BY start_timestamp DESC LIMIT 20`,
      range,
    )

    res.json({
      examples: result.data.map((row) => ({
        time: row.start_timestamp,
        kind: row.exception_type ?? row.span_name,
        message: row.exception_message || row.message || "",
      })),
    })
  } catch (e) {
    console.error("[logfire] usage errors query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/day-log", async (req, res) => {
  try {
    const env = resolveEnv(req)
    const date = String(req.query.date ?? "")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" })
    }
    const minTimestamp = `${date}T00:00:00.000Z`
    const maxTimestamp = new Date(new Date(minTimestamp).getTime() + 24 * 60 * 60 * 1000).toISOString()
    const result = await logfireQuery(
      `SELECT start_timestamp, attributes->>'anon_user_id' as user_id, attributes->'context'->>'entity_type' as entity_type, attributes->'context'->>'entity_id' as entity_id, attributes->>'model' as model FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}' ORDER BY start_timestamp DESC LIMIT 200`,
      { minTimestamp, maxTimestamp },
    )
    const entries = result.data.map((row) => ({
      time: row.start_timestamp,
      userId: row.user_id ?? "unknown",
      entityType: row.entity_type ?? "none",
      entityId: row.entity_id ?? null,
      model: row.model ?? "unknown",
    }))

    const ticketIds = [...new Set(
      entries.filter((e) => e.entityType === "ticket" && e.entityId).map((e) => e.entityId),
    )]
    const ticketTitles = new Map()
    if (ticketIds.length > 0) {
      try {
        const rows = await dwhQuery(
          `SELECT t.id, t.title FROM support.tickets t WHERE t.id IN (${ticketIds.map((_, i) => `@id${i}`).join(",")})`,
          ticketIds.map((id, i) => ({ name: `id${i}`, type: sqlTypes.NVarChar, value: id })),
        )
        for (const row of rows) {
          ticketTitles.set(String(row.id), row.title)
        }
      } catch (dwhErr) {
        console.error("[dwh] ticket title fetch failed:", dwhErr.message)
      }
    }

    res.json({
      entries: entries.map((e) => ({
        ...e,
        ticketTitle: e.entityType === "ticket" ? (ticketTitles.get(e.entityId) ?? null) : null,
      })),
    })
  } catch (e) {
    console.error("[logfire] day log query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/solution-agent/groups", async (req, res) => {
  try {
    const env = resolveEnv(req)
    const tickets = await buildSolutionAgentTickets(env)
    const byClusterRaw = groupTicketsBy(tickets, "clusterId")
    const byCluster = await enrichClusterGroups(
      byClusterRaw,
      tickets.map((t) => t.reference),
    )
    res.json({
      totals: { tickets: tickets.length, runs: tickets.reduce((sum, t) => sum + t.runs, 0) },
      lookbackMonths: SOLUTION_LOOKBACK_MONTHS,
      byCategory: groupTicketsBy(tickets, "category"),
      byProduct: groupTicketsBy(tickets, "product"),
      byCompany: groupTicketsBy(tickets, "company"),
      byCluster,
    })
  } catch (e) {
    console.error("[solution-agent] groups query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

// Registered before the generic /:dimension/:value route below so a literal ":value" of
// "confidence" doesn't get swallowed by that route instead (Express matches by declaration order).
app.get("/api/solution-agent/groups/:dimension/confidence", async (req, res) => {
  try {
    const dimension = req.params.dimension
    const field = SOLUTION_DIMENSIONS[dimension]
    if (!field) {
      return res.status(400).json({ error: "invalid dimension" })
    }
    const env = resolveEnv(req)
    const tickets = await buildSolutionAgentTickets(env)
    const confidenceByGroup = await computeConfidenceForGroups(env, groupTicketsRaw(tickets, field))
    res.json(Object.fromEntries(confidenceByGroup))
  } catch (e) {
    console.error("[solution-agent] group confidence query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/solution-agent/groups/:dimension/:value", async (req, res) => {
  try {
    const dimension = req.params.dimension
    const field = SOLUTION_DIMENSIONS[dimension]
    if (!field) {
      return res.status(400).json({ error: "invalid dimension" })
    }
    const value = decodeURIComponent(req.params.value)
    const env = resolveEnv(req)

    const tickets = await buildSolutionAgentTickets(env)
    const groupTickets = tickets.filter((t) => String(t[field] || UNKNOWN_GROUP) === value)
    if (groupTickets.length === 0) {
      return res.json({
        ticketCount: 0,
        runCount: 0,
        avgDurationSec: 0,
        sampledRuns: 0,
        dailyUsage: [],
        confidence: [],
        sources: [],
        tools: [],
      })
    }

    const refs = groupTickets.map((t) => t.reference)
    const runCount = groupTickets.reduce((sum, t) => sum + t.runs, 0)
    const avgDurationSec =
      runCount > 0 ? groupTickets.reduce((sum, t) => sum + t.avgDurationSec * t.runs, 0) / runCount : 0

    const [dailyUsageResult, sampleResult] = await Promise.all([
      logfireQuery(
        `SELECT date_trunc('day', start_timestamp) as day, count(*) as n FROM records WHERE span_name = 'solution_agent_finished' AND deployment_environment = '${env}' AND attributes->>'reference_number' IN (${sqlList(refs)}) GROUP BY 1 ORDER BY 1`,
        SOLUTION_ALL_TIME_RANGE,
      ),
      logfireQuery(
        `SELECT trace_id FROM records WHERE span_name = 'solution_agent_finished' AND deployment_environment = '${env}' AND attributes->>'reference_number' IN (${sqlList(refs)}) ORDER BY start_timestamp DESC LIMIT ${SOLUTION_SAMPLE_RUN_LIMIT}`,
        SOLUTION_ALL_TIME_RANGE,
      ),
    ])

    const sampleTraceIds = sampleResult.data.map((r) => r.trace_id).filter((id) => TRACE_ID_RE.test(id))
    const { stepsByTrace } = await fetchStepsByTrace(sampleTraceIds, SOLUTION_ALL_TIME_RANGE)

    const confidenceCounts = { high: 0, medium: 0, low: 0, unknown: 0 }
    const sourceCounts = new Map()
    const toolCounts = new Map()

    for (const traceId of sampleTraceIds) {
      const steps = stepsByTrace.get(traceId) ?? []
      const contentSteps = steps.filter((s) => s.type === "agent" || s.type === "chat")
      const solution = contentSteps.length > 0 ? contentSteps[contentSteps.length - 1].output : null

      const confidence = parseConfidence(solution)
      confidenceCounts[confidence ?? "unknown"] += 1

      for (const source of parseSources(solution)) {
        const key = source.url || source.title
        const existing = sourceCounts.get(key) ?? { title: source.title, url: source.url, count: 0 }
        existing.count += 1
        sourceCounts.set(key, existing)
      }

      for (const step of steps) {
        if (step.type !== "tool") continue
        toolCounts.set(step.label, (toolCounts.get(step.label) ?? 0) + 1)
      }
    }

    res.json({
      ticketCount: groupTickets.length,
      runCount,
      avgDurationSec,
      sampledRuns: sampleTraceIds.length,
      dailyUsage: dailyUsageResult.data.map((row) => ({ day: row.day, count: Number(row.n ?? 0) })),
      confidence: [
        { level: "high", count: confidenceCounts.high },
        { level: "medium", count: confidenceCounts.medium },
        { level: "low", count: confidenceCounts.low },
        { level: "unknown", count: confidenceCounts.unknown },
      ],
      sources: [...sourceCounts.values()].sort((a, b) => b.count - a.count).slice(0, 10),
      tools: [...toolCounts.entries()]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    })
  } catch (e) {
    console.error("[solution-agent] group detail query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/ticket-info", async (req, res) => {
  try {
    const ticketIdText = String(req.query.ticketId ?? "")
    const ticketIdNum = parseInt(ticketIdText, 10)
    if (!ticketIdText) return res.status(400).json({ error: "ticketId is required" })
    // Unclear which column the entity ID from Logfire actually lines up with here, so match
    // either: ticket_id (numeric, when parseable) or reference_number (whatever shape it is).
    const rows = await dwhQuery(
      `SELECT ticket_id, reference_number, ticket_title, category_name, category_fullname, implementation_name, company_name, intility_worker_fullname AS owner, ticket_status, ticket_priority FROM customer_inquiries.tickets_last_five_years WHERE ticket_id = @ticketIdNum OR reference_number = @ticketIdText`,
      [
        { name: "ticketIdNum", type: sqlTypes.Int, value: Number.isFinite(ticketIdNum) ? ticketIdNum : null },
        { name: "ticketIdText", type: sqlTypes.NVarChar, value: ticketIdText },
      ],
    )
    const row = rows[0]
    res.json({
      ticket: row
        ? {
            ticketId: String(row.ticket_id),
            referenceNumber: row.reference_number,
            title: row.ticket_title,
            categoryName: row.category_name ?? null,
            categoryFullName: row.category_fullname ?? null,
            implementationName: row.implementation_name ?? null,
            companyName: row.company_name ?? null,
            owner: row.owner ?? null,
            status: row.ticket_status ?? null,
            priority: row.ticket_priority ?? null,
          }
        : null,
    })
  } catch (e) {
    console.error("[dwh] ticket info fetch failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/dwh-test", (_req, res) => {
  const addr = process.env.MINATO_LINK_DWH_ADDR
  if (!addr) {
    return res.json({ reachable: false, reason: "MINATO_LINK_DWH_ADDR not set" })
  }
  const lastColon = addr.lastIndexOf(":")
  const host = addr.slice(0, lastColon)
  const port = parseInt(addr.slice(lastColon + 1), 10)
  const socket = connect({ host, port, timeout: 5000 })
  socket.once("connect", () => {
    socket.destroy()
    res.json({ reachable: true, host, port })
  })
  socket.once("timeout", () => {
    socket.destroy()
    res.json({ reachable: false, host, port, reason: "timeout" })
  })
  socket.once("error", (e) => {
    res.json({ reachable: false, host, port, reason: e.message })
  })
})

if (isProduction) {
  app.use(express.static(distDir))
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"))
  })
}

const port = isProduction ? 8080 : 8787
const host = isProduction ? "0.0.0.0" : "127.0.0.1"
app.listen(port, host, () => {
  console.log(`API server listening on http://${host}:${port} (${isProduction ? "production" : "dev"})`)
})
