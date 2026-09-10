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
    noAnswerCount: number
    noAnswerPercent: number
    totalEntities: number
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
    uses: number
    lastSeen: string
    model: string | null
    reasoningEffort: string | null
    triggers: number
    avgDurationSec: number
    costUsd: number | null
    exceptions: number
    errorCount: number
    noAnswerCount: number
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
  env: Environment,
  range: TimeRange,
): Promise<TicketRun[]> {
  const params = new URLSearchParams({ entityType, env })
  if (entityId) params.set('entityId', entityId)
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
  env: Environment,
  range: TimeRange,
): Promise<UsageErrorExample[]> {
  const params = new URLSearchParams({ entityType, env })
  if (entityId) params.set('entityId', entityId)
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

export type SolutionGroupDimension = 'category' | 'product' | 'company'

export interface SolutionGroupSummary {
  key: string
  ticketCount: number
  runCount: number
  avgDurationSec: number
}

export interface SolutionAgentGroups {
  totals: { tickets: number; runs: number }
  lookbackMonths: number
  byCategory: SolutionGroupSummary[]
  byProduct: SolutionGroupSummary[]
  byCompany: SolutionGroupSummary[]
}

export async function fetchSolutionAgentGroups(env: Environment): Promise<SolutionAgentGroups> {
  return fetchJson(`/api/solution-agent/groups?env=${env}`)
}

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown'

export interface SolutionGroupDetail {
  ticketCount: number
  runCount: number
  avgDurationSec: number
  sampledRuns: number
  dailyUsage: { day: string; count: number }[]
  confidence: { level: ConfidenceLevel; count: number }[]
  sources: { title: string; url: string; count: number }[]
  tools: { tool: string; count: number }[]
}

export async function fetchSolutionGroupDetail(
  dimension: SolutionGroupDimension,
  value: string,
  env: Environment,
): Promise<SolutionGroupDetail> {
  return fetchJson(`/api/solution-agent/groups/${dimension}/${encodeURIComponent(value)}?env=${env}`)
}
