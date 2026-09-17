export type DashboardLevel = 'debug' | 'info' | 'warning' | 'error'

export type StepType = 'agent' | 'chat' | 'tool' | 'finish' | 'info'

export type Environment = 'dev' | 'local' | 'prod' | 'test'

export const ENVIRONMENTS: Environment[] = ['dev', 'local', 'prod', 'test']
export const DEFAULT_ENVIRONMENT: Environment = 'prod'

export interface TimeRange {
  minTimestamp: string
  maxTimestamp: string
}

function rangeQuery(range: TimeRange): string {
  return `minTimestamp=${encodeURIComponent(range.minTimestamp)}&maxTimestamp=${encodeURIComponent(range.maxTimestamp)}`
}

export interface RunStep {
  type: StepType
  label: string
  output: string | null
  /** For `tool` steps: the call's arguments, pretty-printed JSON, matched in from the sibling
   * pydantic-ai `execute_tool` span by tool name + timing (best-effort — there's no shared call
   * id between the two spans). Null when no match was found or the step isn't a tool call. */
  input: string | null
  startedAt: string
  durationSec: number
  isError: boolean
  exceptionMessage: string | null
  exceptionType: string | null
}

export interface TicketRun {
  traceId: string
  timestamp: string
  outcome: string
  durationSec: number
  steps: RunStep[]
  solution: string | null
  costUsd: number
  failureReason: string | null
  hasNoAnswer: boolean
  /** No answer yet, but the request is young enough that its agent run may still be in flight —
   * distinct from a genuine failure. */
  pending: boolean
}

export interface DashboardData {
  totals: {
    medianResponseTimeSec: number
    avgResponseTimeSec: number
    solutionMedianResponseTimeSec: number
    tokensUsed: number
    cachedTokens: number
    costUsd: number
    uniqueUsers: number
    uses: number
    /** Requests across the whole selected range with an empty last chat message, not just the
     * top rows shown in the conversation-log table. */
    noAnswerCount: number
    noAnswerPercent: number
    /** Requests too young to have a genuine answer/exception yet — likely still mid-flight,
     * excluded from noAnswerCount. */
    pendingCount: number
    totalRequests: number
  }
  context: { type: string; count: number }[]
  dailyUsers: { day: string; users: number; messages: number; cumulativeUsers: number }[]
  errors: { total: number; byKind: { kind: string; count: number }[] }
  toolFailures: { tool: string; category: 'agent' | 'direct'; count: number }[]
  securityJudge: { total: number; byKind: { kind: string; count: number }[] }
  tools: { tool: string; calls: number; totalDurationSec: number; avgDurationSec: number; errors: number }[]
  llmCalls: { model: string; calls: number; inputTokens: number; outputTokens: number; totalDurationSec: number }[]
  models: {
    model: string
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    calls: number
  }[]
  usage: {
    entityType: string
    entityId: string | null
    /** Real entity id when there is one; otherwise the chat_id (or, for a chat's first turn
     * before it has one yet, the trace_id) identifying this specific conversation. Always
     * present — pass it to fetchUsageRuns/fetchUsageErrors so context-less rows resolve to their
     * own conversation instead of every context-less chat in the range. */
    groupKey: string
    uses: number
    lastSeen: string
    model: string | null
    reasoningEffort: string | null
    triggers: number
    avgDurationSec: number
    costUsd: number | null
    exceptions: number
    errorCount: number
    /** Count of this entity's `uses` requests that got an empty last chat message. */
    noAnswerCount: number
    /** Count of this entity's `uses` requests too young to have a genuine answer yet. */
    pendingCount: number
    runs: TicketRun[]
  }[]
  dailyCost: { day: string; cost: number; cumulativeCost: number }[]
  dailyUsageByContext: { day: string; type: string; count: number }[]
  dailyErrorsByKind: { day: string; kind: string; count: number }[]
  dailyToolFailures: { day: string; tool: string; count: number }[]
  dailySecurityJudge: { day: string; kind: string; count: number }[]
  dailyNoAnswer: { day: string; total: number; noAnswer: number; percent: number }[]
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return res.json()
}

export async function fetchDashboard(env: Environment, range: TimeRange): Promise<DashboardData> {
  return fetchJson(`/api/dashboard?env=${env}&${rangeQuery(range)}`)
}

export async function fetchUsageRuns(
  entityType: string,
  entityId: string | null,
  groupKey: string,
  env: Environment,
  range: TimeRange,
): Promise<TicketRun[]> {
  const params = new URLSearchParams({ entityType, env })
  if (entityId) params.set('entityId', entityId)
  else params.set('groupKey', groupKey)
  const body = await fetchJson<{ runs: TicketRun[] }>(`/api/usage-runs?${params.toString()}&${rangeQuery(range)}`)
  return body.runs
}

export interface UsageErrorExample {
  time: string
  kind: string
  message: string
}

export async function fetchUsageErrors(
  entityType: string,
  entityId: string | null,
  groupKey: string,
  env: Environment,
  range: TimeRange,
): Promise<UsageErrorExample[]> {
  const params = new URLSearchParams({ entityType, env })
  if (entityId) params.set('entityId', entityId)
  else params.set('groupKey', groupKey)
  const body = await fetchJson<{ examples: UsageErrorExample[] }>(
    `/api/usage-errors?${params.toString()}&${rangeQuery(range)}`,
  )
  return body.examples
}

export interface ErrorExample {
  time: string
  service: string
  message: string
  exceptionType: string | null
  model: string | null
  ticketId: string | null
}

export async function fetchErrorExamples(
  kind: string,
  env: Environment,
  range: TimeRange,
): Promise<ErrorExample[]> {
  const body = await fetchJson<{ examples: ErrorExample[] }>(
    `/api/errors/${encodeURIComponent(kind)}?env=${env}&${rangeQuery(range)}`,
  )
  return body.examples
}

export interface ToolFailureExample {
  time: string
  kind: 'exception' | 'timeout'
  detail: string
  model: string | null
  ticketId: string | null
  /** The tool call's arguments, pretty-printed JSON, when Logfire captured a matching call in the
   * same trace; null when no match was found (e.g. direct/background tool calls, which bypass the
   * agent span this is matched against). */
  input: string | null
}

export async function fetchToolFailureExamples(
  tool: string,
  category: 'agent' | 'direct',
  env: Environment,
  range: TimeRange,
): Promise<ToolFailureExample[]> {
  const body = await fetchJson<{ examples: ToolFailureExample[] }>(
    `/api/tool-failures/${encodeURIComponent(tool)}?category=${category}&env=${env}&${rangeQuery(range)}`,
  )
  return body.examples
}

export interface SecurityJudgeExample {
  time: string
  ticketId: string | null
  detail: string
}

export async function fetchSecurityJudgeExamples(
  kind: string,
  env: Environment,
  range: TimeRange,
): Promise<SecurityJudgeExample[]> {
  const body = await fetchJson<{ examples: SecurityJudgeExample[] }>(
    `/api/security-judge/${encodeURIComponent(kind)}?env=${env}&${rangeQuery(range)}`,
  )
  return body.examples
}

export interface DayLogEntry {
  time: string
  userId: string
  entityType: string
  entityId: string | null
  model: string
  ticketTitle: string | null
}

export async function fetchDayLog(date: string, env: Environment): Promise<DayLogEntry[]> {
  const body = await fetchJson<{ entries: DayLogEntry[] }>(
    `/api/day-log?date=${encodeURIComponent(date)}&env=${env}`,
  )
  return body.entries
}

export interface TicketInfo {
  ticketId: string
  referenceNumber: string
  title: string
  categoryName: string | null
  categoryFullName: string | null
  implementationName: string | null
  companyName: string | null
  owner: string | null
  status: string | null
  priority: string | null
}

export async function fetchTicketInfo(ticketId: string): Promise<TicketInfo | null> {
  const body = await fetchJson<{ ticket: TicketInfo | null }>(
    `/api/ticket-info?ticketId=${encodeURIComponent(ticketId)}`,
  )
  return body.ticket
}

export interface NoAnswerExample {
  time: string
  traceId: string
  durationSec: number
  reason: string
  model: string | null
  ticketId: string | null
}

export async function fetchNoAnswerExamples(env: Environment, range: TimeRange): Promise<NoAnswerExample[]> {
  const body = await fetchJson<{ examples: NoAnswerExample[] }>(
    `/api/no-answer?env=${env}&${rangeQuery(range)}`,
  )
  return body.examples
}

export type SolutionGroupDimension = 'category' | 'product' | 'company' | 'cluster'

export interface SolutionGroupSummary {
  key: string
  label: string
  ticketCount: number
  runCount: number
  avgDurationSec: number
  medianCloseDaysAi: number | null
  // Only populated for the 'cluster' dimension.
  hierarchyName?: string | null
  otherTicketCount?: number
  totalTicketCount?: number
  medianCloseDaysOther?: number | null
}

export interface SolutionAgentGroups {
  totals: { tickets: number; runs: number }
  lookbackMonths: number
  byCategory: SolutionGroupSummary[]
  byProduct: SolutionGroupSummary[]
  byCompany: SolutionGroupSummary[]
  byCluster: SolutionGroupSummary[]
}

export async function fetchSolutionAgentGroups(env: Environment): Promise<SolutionAgentGroups> {
  return fetchJson(`/api/solution-agent/groups?env=${env}`)
}

export interface GroupConfidence {
  highPercent: number | null
  mediumPercent: number | null
  sampledRuns: number
}

export async function fetchSolutionGroupConfidence(
  dimension: SolutionGroupDimension,
  env: Environment,
): Promise<Record<string, GroupConfidence>> {
  return fetchJson(`/api/solution-agent/groups/${dimension}/confidence?env=${env}`)
}

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown'

export type SourceType = 'ticket' | 'article' | 'cmdb' | 'msdocs' | 'other'

export interface SolutionGroupDetail {
  ticketCount: number
  runCount: number
  avgDurationSec: number
  sampledRuns: number
  dailyUsage: { day: string; count: number }[]
  confidence: { level: ConfidenceLevel; count: number }[]
  sources: { title: string; url: string; count: number }[]
  sourceTypes: { type: SourceType; count: number }[]
  tools: { tool: string; count: number }[]
}

export async function fetchSolutionGroupDetail(
  dimension: SolutionGroupDimension,
  value: string,
  env: Environment,
): Promise<SolutionGroupDetail> {
  return fetchJson(`/api/solution-agent/groups/${dimension}/detail?value=${encodeURIComponent(value)}&env=${env}`)
}
