import path from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { connect } from "node:net"
import express from "express"
import { logfireQuery } from "./logfire.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, "..", "dist")
const isProduction = existsSync(path.join(distDir, "index.html"))

const app = express()

// Live telemetry: never let a browser, proxy, or CDN cache these responses.
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
})
const HOURS_BACK_ACTIVITY = 24
const HOURS_BACK_INSIGHTS = 24 * 7
const TRACE_ID_RE = /^[0-9a-f]{32}$/i

const ALLOWED_ENVIRONMENTS = new Set(["dev", "local", "prod", "test"])
const DEFAULT_ENVIRONMENT = "prod"

/** Reads ?env= from the request, falling back to prod for anything unrecognized. */
function resolveEnv(req) {
  const env = String(req.query.env ?? DEFAULT_ENVIRONMENT)
  return ALLOWED_ENVIRONMENTS.has(env) ? env : DEFAULT_ENVIRONMENT
}

function levelLabel(level) {
  if (level == null) return "info"
  if (level >= 17) return "error"
  if (level >= 13) return "warning"
  if (level >= 9) return "info"
  return "debug"
}

function sqlList(values) {
  return values.map((v) => `'${v}'`).join(",")
}

const SKIPPED_SPANS = new Set(["POST /api/v2/chat", "OPTIONS /api/v2/chat", "chat.request"])

const TOOL_FAILURE_TEMPLATES = ["MCP tool %s raised exception: %s", "MCP tool %s timed out after %ds"]
const TOOL_FAILURE_TEMPLATE_LIST = TOOL_FAILURE_TEMPLATES.map((t) => `'${t}'`).join(",")

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
    return { type: "tool", label: spanName.slice(11), output: null }
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
    label: spanName,
    output: row.message && row.message !== spanName ? row.message : null,
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
    `SELECT trace_id, start_timestamp, duration, span_name, message, level, attributes FROM records WHERE trace_id IN (${traceList}) ORDER BY start_timestamp`,
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
      startedAt: row.start_timestamp,
      durationSec: row.duration ?? 0,
    })
  }
  return { stepsByTrace, exceptionTraces }
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
    const startOfToday = new Date()
    startOfToday.setUTCHours(0, 0, 0, 0)
    const today = { minTimestamp: startOfToday.toISOString() }
    const activity = { hoursBack: HOURS_BACK_ACTIVITY }
    const insights = { hoursBack: HOURS_BACK_INSIGHTS }
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
      recentResult,
      toolsResult,
      modelsResult,
      solutionRunsResult,
      dailyCostResult,
    ] = await Promise.all([
      logfireQuery(
        `SELECT approx_percentile_cont(duration, 0.5) as median_dur, avg(duration) as avg_dur FROM records WHERE attributes->>'gen_ai.operation.name' = 'invoke_agent' AND deployment_environment = '${env}'`,
        today,
      ),
      logfireQuery(
        `SELECT sum(COALESCE(CAST(attributes->>'gen_ai.usage.input_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.input_tokens' AS BIGINT)) + COALESCE(CAST(attributes->>'gen_ai.usage.output_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.output_tokens' AS BIGINT))) as total_tokens, sum(CAST(attributes->>'gen_ai.aggregated_usage.cache_read.input_tokens' AS BIGINT)) as cached_tokens, sum(CAST(attributes->'logfire.metrics'->'operation.cost'->>'total' AS DOUBLE)) as cost_usd FROM records WHERE attributes->>'gen_ai.operation.name' = 'invoke_agent' AND deployment_environment = '${env}'`,
        today,
      ),
      logfireQuery(
        `SELECT count(distinct attributes->>'anon_user_id') as users, count(*) as uses FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}'`,
        today,
      ),
      logfireQuery(
        `SELECT COALESCE(attributes->'context'->>'entity_type', 'none') as entity_type, count(*) as n FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY n DESC`,
        insights,
      ),
      logfireQuery(
        `SELECT date_trunc('day', start_timestamp) as day, count(distinct attributes->>'anon_user_id') as users, count(*) as messages FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY 1`,
        insights,
      ),
      logfireQuery(`SELECT count(*) as n FROM records WHERE level >= 17 AND deployment_environment = '${env}'`, insights),
      logfireQuery(
        `SELECT COALESCE(exception_type, attributes->>'logfire.msg_template', span_name) as kind, count(*) as n FROM records WHERE level >= 17 AND deployment_environment = '${env}' GROUP BY 1 ORDER BY n DESC LIMIT 6`,
        insights,
      ),
      logfireQuery(
        `SELECT attributes->'logfire.logging_args'->>0 as tool, count(*) as n FROM records WHERE level >= 17 AND attributes->>'logfire.msg_template' IN (${TOOL_FAILURE_TEMPLATE_LIST}) AND deployment_environment = '${env}' GROUP BY 1 ORDER BY n DESC LIMIT 10`,
        insights,
      ),
      logfireQuery(
        `SELECT span_name, count(*) as n FROM records WHERE span_name IN (${SECURITY_JUDGE_SPAN_LIST}) AND deployment_environment = '${env}' GROUP BY 1 ORDER BY n DESC`,
        insights,
      ),
      logfireQuery(
        `SELECT entity_type, entity_id, n, last_seen, model, reasoning_effort FROM (
          SELECT
            COALESCE(attributes->'context'->>'entity_type', 'none') as entity_type,
            attributes->'context'->>'entity_id' as entity_id,
            attributes->>'model' as model,
            attributes->>'reasoning_effort' as reasoning_effort,
            start_timestamp,
            COUNT(*) OVER (PARTITION BY COALESCE(attributes->'context'->>'entity_type', 'none'), attributes->'context'->>'entity_id') as n,
            MAX(start_timestamp) OVER (PARTITION BY COALESCE(attributes->'context'->>'entity_type', 'none'), attributes->'context'->>'entity_id') as last_seen,
            ROW_NUMBER() OVER (PARTITION BY COALESCE(attributes->'context'->>'entity_type', 'none'), attributes->'context'->>'entity_id' ORDER BY start_timestamp DESC) as rn
          FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}'
        ) WHERE rn = 1 ORDER BY last_seen DESC LIMIT 100`,
        insights,
      ),
      logfireQuery(
        `SELECT start_timestamp, service_name, level, message FROM records WHERE deployment_environment = '${env}' ORDER BY start_timestamp DESC LIMIT 15`,
        activity,
      ),
      logfireQuery(
        `SELECT attributes->>'gen_ai.tool.name' as tool, count(*) as n FROM records WHERE span_name = 'running tool' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY n DESC LIMIT 10`,
        insights,
      ),
      logfireQuery(
        `SELECT attributes->>'model_name' as model, sum(COALESCE(CAST(attributes->>'gen_ai.usage.input_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.input_tokens' AS BIGINT))) as input_tokens, sum(COALESCE(CAST(attributes->>'gen_ai.usage.output_tokens' AS BIGINT), CAST(attributes->>'gen_ai.aggregated_usage.output_tokens' AS BIGINT))) as output_tokens, sum(CAST(attributes->'logfire.metrics'->'operation.cost'->>'total' AS DOUBLE)) as cost_usd, count(*) as calls FROM records WHERE attributes->>'gen_ai.operation.name' = 'invoke_agent' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY calls DESC LIMIT 8`,
        insights,
      ),
      logfireQuery(
        `SELECT trace_id, start_timestamp, attributes->>'reference_number' as ticket, attributes->>'outcome' as outcome, CAST(attributes->>'duration_s' AS DOUBLE) as duration_s FROM records WHERE span_name = 'solution_agent_finished' AND deployment_environment = '${env}' ORDER BY start_timestamp DESC LIMIT 200`,
        insights,
      ),
      logfireQuery(
        `SELECT date_trunc('day', start_timestamp) as day, sum(CAST(attributes->'logfire.metrics'->'operation.cost'->>'total' AS DOUBLE)) as cost FROM records WHERE attributes->>'gen_ai.operation.name' = 'invoke_agent' AND deployment_environment = '${env}' GROUP BY 1 ORDER BY 1`,
        insights,
      ),
    ])

    const allTickets = groupRunsByTicket(solutionRunsResult.data)
    const detailedTickets = allTickets.slice(0, 15)
    const traceIds = [
      ...new Set(
        detailedTickets.flatMap((t) => t.runs.map((r) => r.trace_id)).filter((id) => TRACE_ID_RE.test(id)),
      ),
    ]

    const { stepsByTrace } = await fetchStepsByTrace(traceIds, insights)

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
          }
        }
        const agentSteps = steps.filter((s) => s.type === "agent" && s.output)
        const solution = agentSteps.length > 0 ? agentSteps[agentSteps.length - 1].output : null
        const costUsd = steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
        return {
          traceId: r.trace_id,
          timestamp: r.start_timestamp,
          outcome: r.outcome ?? "unknown",
          durationSec: r.duration_s ?? 0,
          steps,
          solution,
          costUsd,
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
    const solutionAvgResponseTimeSec =
      solutionDurations.length > 0
        ? solutionDurations.reduce((sum, d) => sum + d, 0) / solutionDurations.length
        : 0

    res.json({
      totals: {
        medianResponseTimeSec: Number(responseTimeRow.median_dur ?? 0),
        avgResponseTimeSec: Number(responseTimeRow.avg_dur ?? 0),
        solutionMedianResponseTimeSec: Number(solutionMedianResponseTimeSec ?? 0),
        solutionAvgResponseTimeSec: Number(solutionAvgResponseTimeSec ?? 0),
        tokensUsed: Number(tokensCostRow.total_tokens ?? 0),
        cachedTokens: Number(tokensCostRow.cached_tokens ?? 0),
        costUsd: Number(tokensCostRow.cost_usd ?? 0),
        uniqueUsers: Number(usageTodayRow.users ?? 0),
        uses: Number(usageTodayRow.uses ?? 0),
      },
      context: contextResult.data.map((row) => ({ type: row.entity_type, count: Number(row.n ?? 0) })),
      dailyUsers: dailyUsersResult.data.map((row) => ({
        day: row.day,
        users: Number(row.users ?? 0),
        messages: Number(row.messages ?? 0),
      })),
      errors: {
        total: Number(errorsTotalResult.data[0]?.n ?? 0),
        byKind: errorKindsResult.data
          .filter((row) => row.kind)
          .map((row) => ({ kind: row.kind, count: Number(row.n ?? 0) })),
      },
      toolFailures: toolFailuresResult.data
        .filter((row) => row.tool)
        .map((row) => ({ tool: row.tool, count: Number(row.n ?? 0) })),
      securityJudge: {
        total: securityJudgeResult.data.reduce((sum, row) => sum + Number(row.n ?? 0), 0),
        byKind: securityJudgeResult.data.map((row) => ({
          kind: SECURITY_JUDGE_LABELS[row.span_name] ?? row.span_name,
          count: Number(row.n ?? 0),
        })),
      },
      tools: toolsResult.data
        .filter((row) => row.tool)
        .map((row) => ({ tool: row.tool, count: Number(row.n ?? 0) })),
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
      recent: recentResult.data.map((row) => ({
        time: row.start_timestamp,
        service: row.service_name ?? "unknown",
        level: levelLabel(row.level),
        message: row.message ?? "",
      })),
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
    const insights = { hoursBack: HOURS_BACK_INSIGHTS }
    const result = await logfireQuery(
      `SELECT start_timestamp, service_name, message, exception_message FROM records WHERE level >= 17 AND deployment_environment = '${env}' AND COALESCE(exception_type, attributes->>'logfire.msg_template', span_name) = '${kind}' ORDER BY start_timestamp DESC LIMIT 15`,
      insights,
    )
    res.json({
      examples: result.data.map((row) => ({
        time: row.start_timestamp,
        service: row.service_name ?? "unknown",
        message: row.exception_message || row.message || "",
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
    const insights = { hoursBack: HOURS_BACK_INSIGHTS }
    const result = await logfireQuery(
      `SELECT start_timestamp, attributes->>'logfire.msg_template' as template, attributes->'logfire.logging_args'->>1 as detail FROM records WHERE level >= 17 AND deployment_environment = '${env}' AND attributes->>'logfire.msg_template' IN (${TOOL_FAILURE_TEMPLATE_LIST}) AND attributes->'logfire.logging_args'->>0 = '${tool}' ORDER BY start_timestamp DESC LIMIT 15`,
      insights,
    )
    res.json({
      examples: result.data.map((row) => ({
        time: row.start_timestamp,
        kind: row.template?.includes("timed out") ? "timeout" : "exception",
        detail: row.template?.includes("timed out") ? `Timed out after ${row.detail}s` : row.detail ?? "",
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
    const insights = { hoursBack: HOURS_BACK_INSIGHTS }
    const result = await logfireQuery(
      `SELECT start_timestamp, attributes->>'ticket_id' as ticket_id, attributes->>'flagged_content' as flagged_content, attributes->'logfire.logging_args'->>0 as tool_name FROM records WHERE span_name = '${spanName.replace(/'/g, "''")}' AND deployment_environment = '${env}' ORDER BY start_timestamp DESC LIMIT 15`,
      insights,
    )
    res.json({
      examples: result.data.map((row) => {
        const content = row.flagged_content ?? (row.tool_name ? `Tool: ${row.tool_name}` : "")
        return {
          time: row.start_timestamp,
          ticketId: row.ticket_id && row.ticket_id !== "-" ? row.ticket_id : null,
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
    const insights = { hoursBack: HOURS_BACK_INSIGHTS }

    const entityIdFilter = entityId
      ? `attributes->'context'->>'entity_id' = '${entityId}'`
      : `attributes->'context'->>'entity_id' IS NULL`

    const requestsResult = await logfireQuery(
      `SELECT trace_id, start_timestamp, duration FROM records WHERE span_name = 'chat.request' AND deployment_environment = '${env}' AND COALESCE(attributes->'context'->>'entity_type', 'none') = '${entityType}' AND ${entityIdFilter} ORDER BY start_timestamp DESC LIMIT 20`,
      insights,
    )

    const traceIds = requestsResult.data.map((r) => r.trace_id).filter((id) => TRACE_ID_RE.test(id))
    const { stepsByTrace, exceptionTraces } = await fetchStepsByTrace(traceIds, insights)

    const runs = requestsResult.data.map((row) => {
      const steps = stepsByTrace.get(row.trace_id) ?? []
      const outputSteps = steps.filter((s) => (s.type === "agent" || s.type === "chat") && s.output)
      const solution = outputSteps.length > 0 ? outputSteps[outputSteps.length - 1].output : null
      const costUsd = steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
      return {
        traceId: row.trace_id,
        timestamp: row.start_timestamp,
        outcome: exceptionTraces.has(row.trace_id) ? "exception" : "completed",
        durationSec: row.duration ?? 0,
        steps,
        solution,
        costUsd: costUsd > 0 ? costUsd : null,
      }
    })

    res.json({ runs })
  } catch (e) {
    console.error("[logfire] usage runs query failed:", e.message)
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
    res.json({
      entries: result.data.map((row) => ({
        time: row.start_timestamp,
        userId: row.user_id ?? "unknown",
        entityType: row.entity_type ?? "none",
        entityId: row.entity_id ?? null,
        model: row.model ?? "unknown",
      })),
    })
  } catch (e) {
    console.error("[logfire] day log query failed:", e.message)
    res.status(e.status ?? 502).json({ error: e.message })
  }
})

app.get("/api/dwh-test", (_req, res) => {
  const host = "g-datascience-3.gamma.xcv.net"
  const port = 1433
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
