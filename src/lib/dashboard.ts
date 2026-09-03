export type DashboardLevel = 'debug' | 'info' | 'warning' | 'error'

export type StepType = 'agent' | 'chat' | 'tool' | 'finish' | 'info'

export interface RunStep {
  type: StepType
  label: string
  output: string | null
  startedAt: string
  durationSec: number
}

export interface TicketRun {
  traceId: string
  timestamp: string
  outcome: string
  durationSec: number
  steps: RunStep[]
  solution: string | null
  costUsd: number
}

export interface DashboardData {
  totals: {
    medianResponseTimeSec: number
    avgResponseTimeSec: number
    highConfidencePct: number | null
    tokensUsed: number
    cachedTokens: number
    costUsd: number
  }
  context: { type: string; count: number }[]
  dailyUsers: { day: string; users: number; messages: number }[]
  errors: { total: number; byKind: { kind: string; count: number }[] }
  toolFailures: { tool: string; count: number }[]
  tools: { tool: string; count: number }[]
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
    triggers: number
    avgDurationSec: number
    costUsd: number | null
    exceptions: number
    runs: TicketRun[]
  }[]
  dailyCost: { day: string; cost: number; cumulativeCost: number }[]
  recent: {
    time: string
    service: string
    level: DashboardLevel
    message: string
  }[]
}

export async function fetchDashboard(): Promise<DashboardData> {
  const res = await fetch('/api/dashboard')
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return res.json()
}

export interface ErrorExample {
  time: string
  service: string
  message: string
}

export async function fetchErrorExamples(kind: string): Promise<ErrorExample[]> {
  const res = await fetch(`/api/errors/${encodeURIComponent(kind)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return (await res.json()).examples
}

export interface ToolFailureExample {
  time: string
  kind: 'exception' | 'timeout'
  detail: string
}

export async function fetchToolFailureExamples(tool: string): Promise<ToolFailureExample[]> {
  const res = await fetch(`/api/tool-failures/${encodeURIComponent(tool)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return (await res.json()).examples
}

export interface DayLogEntry {
  time: string
  userId: string
  entityType: string
  entityId: string | null
  model: string
}

export async function fetchDayLog(date: string): Promise<DayLogEntry[]> {
  const res = await fetch(`/api/day-log?date=${encodeURIComponent(date)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return (await res.json()).entries
}
