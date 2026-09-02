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
    avgTokensPerChat: number
  }
  context: { type: string; count: number }[]
  timeline: { hour: string; count: number }[]
  tools: { tool: string; count: number }[]
  models: {
    model: string
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    calls: number
  }[]
  tickets: {
    ticket: string
    triggers: number
    lastSeen: string
    exceptions: number
    avgDurationSec: number
    costUsd: number
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
