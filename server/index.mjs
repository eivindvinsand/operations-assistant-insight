import path from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import express from "express"
import { logfireQuery } from "./logfire.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, "..", "dist")
const isProduction = existsSync(path.join(distDir, "index.html"))

const app = express()
const HOURS_BACK_ACTIVITY = 24
const HOURS_BACK_INSIGHTS = 24 * 7
const TRACE_ID_RE = /^[0-9a-f]{32}$/i

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
    return { type: "agent", label: "Agent reasoning", output: attributes.final_result ?? null }
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

app.get("/api/dashboard", async (_req, res) => {
  try {
    const activity = { hoursBack: HOURS_BACK_ACTIVITY }
    const insights = { hoursBack: HOURS_BACK_INSIGHTS }
    const [
      totalsResult,
      timelineResult,
      recentResult,
      tokensResult,
      toolsResult,
      modelsResult,
      solutionTotalsResult,
      solutionRunsResult,
    ] = await Promise.all([
      logfireQuery(
        "SELECT count(*) as events, count(*) FILTER (WHERE level >= 17) as errors FROM records",
        activity,
      ),
      logfireQuery(
        "SELECT date_trunc('hour', start_timestamp) as hour, count(*) as count FROM records GROUP BY 1 ORDER BY 1",
        activity,
      ),
      logfireQuery(
        "SELECT start_timestamp, service_name, level, message FROM records ORDER BY start_timestamp DESC LIMIT 15",
        activity,
      ),
      logfireQuery(
        "SELECT sum(CAST(attributes->>'gen_ai.usage.input_tokens' AS BIGINT)) as input_tokens, sum(CAST(attributes->>'gen_ai.usage.output_tokens' AS BIGINT)) as output_tokens FROM records WHERE span_name = 'agent run'",
        insights,
      ),
      logfireQuery(
        "SELECT attributes->>'gen_ai.tool.name' as tool, count(*) as n FROM records WHERE span_name = 'running tool' GROUP BY 1 ORDER BY n DESC LIMIT 10",
        insights,
      ),
      logfireQuery(
        "SELECT attributes->>'model_name' as model, sum(CAST(attributes->>'gen_ai.usage.input_tokens' AS BIGINT)) as input_tokens, sum(CAST(attributes->>'gen_ai.usage.output_tokens' AS BIGINT)) as output_tokens, count(*) as calls FROM records WHERE span_name = 'agent run' GROUP BY 1 ORDER BY calls DESC LIMIT 8",
        insights,
      ),
      logfireQuery(
        "SELECT count(*) as runs, count(distinct attributes->>'reference_number') as tickets, avg(CAST(attributes->>'duration_s' AS DOUBLE)) as avg_duration FROM records WHERE span_name = 'solution_agent_finished'",
        insights,
      ),
      logfireQuery(
        "SELECT trace_id, start_timestamp, attributes->>'reference_number' as ticket, attributes->>'outcome' as outcome, CAST(attributes->>'duration_s' AS DOUBLE) as duration_s FROM records WHERE span_name = 'solution_agent_finished' ORDER BY start_timestamp DESC LIMIT 200",
        insights,
      ),
    ])

    const grouped = groupRunsByTicket(solutionRunsResult.data).slice(0, 15)
    const traceIds = [
      ...new Set(
        grouped.flatMap((t) => t.runs.map((r) => r.trace_id)).filter((id) => TRACE_ID_RE.test(id)),
      ),
    ]

    let stepsByTrace = new Map()

    if (traceIds.length > 0) {
      const traceList = sqlList(traceIds)
      const runStepsResult = await logfireQuery(
        `SELECT trace_id, start_timestamp, duration, span_name, message, attributes FROM records WHERE trace_id IN (${traceList}) ORDER BY start_timestamp`,
        insights,
      )

      for (const row of runStepsResult.data) {
        if (SKIPPED_SPANS.has(row.span_name)) continue
        if (!stepsByTrace.has(row.trace_id)) stepsByTrace.set(row.trace_id, [])
        const classified = classifyStep(row)
        stepsByTrace.get(row.trace_id).push({
          ...classified,
          startedAt: row.start_timestamp,
          durationSec: row.duration ?? 0,
        })
      }
    }

    const totalsRow = totalsResult.data[0] ?? { events: 0, errors: 0 }
    const tokensRow = tokensResult.data[0] ?? { input_tokens: 0, output_tokens: 0 }
    const solutionRow = solutionTotalsResult.data[0] ?? { runs: 0, tickets: 0, avg_duration: 0 }

    res.json({
      totals: {
        events: Number(totalsRow.events ?? 0),
        errors: Number(totalsRow.errors ?? 0),
        inputTokens: Number(tokensRow.input_tokens ?? 0),
        outputTokens: Number(tokensRow.output_tokens ?? 0),
        solutionAgentRuns: Number(solutionRow.runs ?? 0),
        solutionAgentTickets: Number(solutionRow.tickets ?? 0),
        solutionAgentAvgDurationSec: Number(solutionRow.avg_duration ?? 0),
      },
      timeline: timelineResult.data.map((row) => ({
        hour: row.hour,
        count: Number(row.count ?? 0),
      })),
      tools: toolsResult.data
        .filter((row) => row.tool)
        .map((row) => ({ tool: row.tool, count: Number(row.n ?? 0) })),
      models: modelsResult.data
        .filter((row) => row.model)
        .map((row) => ({
          model: row.model,
          inputTokens: Number(row.input_tokens ?? 0),
          outputTokens: Number(row.output_tokens ?? 0),
          calls: Number(row.calls ?? 0),
        })),
      tickets: grouped.map((t) => ({
        ticket: t.ticket,
        triggers: t.runs.length,
        lastSeen: t.lastSeen,
        exceptions: t.runs.filter((r) => r.outcome === "exception").length,
        avgDurationSec:
          t.runs.reduce((sum, r) => sum + (r.duration_s ?? 0), 0) / t.runs.length,
        runs: t.runs.map((r) => {
          const steps = stepsByTrace.get(r.trace_id) ?? []
          const agentSteps = steps.filter((s) => s.type === "agent" && s.output)
          const solution = agentSteps.length > 0 ? agentSteps[agentSteps.length - 1].output : null
          return {
            traceId: r.trace_id,
            timestamp: r.start_timestamp,
            outcome: r.outcome ?? "unknown",
            durationSec: r.duration_s ?? 0,
            steps,
            solution,
          }
        }),
      })),
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
