import { useCallback, useEffect, useState } from 'react'
import { marked } from 'marked'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  faArrowsRotate,
  faBrain,
  faCircleInfo,
  faCoins,
  faComments,
  faFlagCheckered,
  faStopwatch,
  faTriangleExclamation,
  faWrench,
} from '@fortawesome/free-solid-svg-icons'
import Box from '@intility/bifrost-react/Box'
import Grid from '@intility/bifrost-react/Grid'
import Inline from '@intility/bifrost-react/Inline'
import Icon from '@intility/bifrost-react/Icon'
import Button from '@intility/bifrost-react/Button'
import Badge from '@intility/bifrost-react/Badge'
import Message from '@intility/bifrost-react/Message'
import Table from '@intility/bifrost-react/Table'
import Accordion from '@intility/bifrost-react/Accordion'
import Modal from '@intility/bifrost-react/Modal'
import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  fetchDashboard,
  fetchDayLog,
  fetchErrorExamples,
  fetchToolFailureExamples,
  type DashboardData,
  type DashboardLevel,
  type DayLogEntry,
  type Environment,
  type ErrorExample,
  type RunStep,
  type StepType,
  type TicketRun,
  type ToolFailureExample,
} from '../lib/dashboard'

const OPS_MANAGER_BASE = 'https://internal-operations-staging.apps.aa.intility.com'

// Only "tickets" is confirmed - the others follow the same URL pattern but haven't been verified.
const ENTITY_URL_BASE: Record<string, string> = {
  ticket: `${OPS_MANAGER_BASE}/tickets`,
  incident: `${OPS_MANAGER_BASE}/incidents`,
  problem: `${OPS_MANAGER_BASE}/problems`,
  change: `${OPS_MANAGER_BASE}/changes`,
  project: `${OPS_MANAGER_BASE}/projects`,
}

const entityBadgeState: Record<string, 'neutral' | 'warning' | 'alert' | 'success' | 'brand' | 'chill' | 'attn'> = {
  ticket: 'chill',
  incident: 'attn',
  problem: 'warning',
  chat: 'success',
  change: 'brand',
  project: 'brand',
  none: 'neutral',
}

function entityLink(entityType: string, entityId: string | null): string | null {
  const base = ENTITY_URL_BASE[entityType]
  if (!base || !entityId) return null
  return `${base}/${entityId}`
}

const levelBadgeState: Record<DashboardLevel, 'neutral' | 'warning' | 'alert'> = {
  debug: 'neutral',
  info: 'neutral',
  warning: 'warning',
  error: 'alert',
}

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'short',
  timeStyle: 'medium',
})

const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact' })

const costFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
})

const preciseCostFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 3,
})

const dayFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit' })

const usageMonthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short' })

/** Formats like "3.Sep, 08:17". */
function formatUsageTimestamp(iso: string): string {
  const d = new Date(iso)
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${d.getDate()}.${usageMonthFormatter.format(d)}, ${hours}:${minutes}`
}

const tooltipContentStyle = {
  background: 'var(--bfc-base-3)',
  border: '1px solid var(--bfc-base-c-dimmed)',
  borderRadius: 8,
  color: 'var(--bfc-base-c)',
}
const tooltipItemStyle = { color: 'var(--bfc-base-c)' }
const tooltipLabelStyle = { color: 'var(--bfc-base-c-2)' }

function DailyUsersTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: { payload: { label: string; users: number; messages: number } }[]
}) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div style={{ ...tooltipContentStyle, padding: '8px 12px' }}>
      <div style={{ ...tooltipLabelStyle, marginBottom: 4 }}>{point.label}</div>
      <div style={tooltipItemStyle}>{point.users} active users</div>
      <div style={tooltipItemStyle}>{point.messages} messages</div>
    </div>
  )
}

const CONTEXT_COLORS: Record<string, string> = {
  ticket: 'var(--bfc-chill)',
  incident: 'var(--bfc-attn)',
  problem: 'var(--bfc-warning)',
  chat: 'var(--bfc-success)',
  change: 'var(--bfc-brand)',
  project: 'var(--bfc-base-c-2)',
  none: 'var(--bfc-base-c-dimmed)',
}
const FALLBACK_CONTEXT_COLORS = [
  'var(--bfc-chill)',
  'var(--bfc-attn)',
  'var(--bfc-warning)',
  'var(--bfc-success)',
  'var(--bfc-brand)',
]
function contextColor(type: string, index: number): string {
  return CONTEXT_COLORS[type] ?? FALLBACK_CONTEXT_COLORS[index % FALLBACK_CONTEXT_COLORS.length]
}

const BREAKDOWN_COLORS = [
  'var(--bfc-chill)',
  'var(--bfc-attn)',
  'var(--bfc-warning)',
  'var(--bfc-success)',
  'var(--bfc-brand)',
  'var(--bfc-base-c-2)',
]

function BreakdownBars({
  items,
  onSelect,
}: {
  items: { label: string; count: number }[]
  onSelect: (label: string) => void
}) {
  const max = items[0]?.count ?? 1
  return (
    <Grid gap={8}>
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          onClick={() => onSelect(item.label)}
          style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
        >
          <Inline align="center" gap={12}>
            <Inline.Stretch>
              <small className="bfc-base-2" style={{ display: 'block', marginBottom: 2 }}>
                {item.label}
              </small>
              <div style={{ height: 6, background: 'var(--bfc-base-3)', borderRadius: 3, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${(item.count / max) * 100}%`,
                    background: BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length],
                  }}
                />
              </div>
            </Inline.Stretch>
            <small className="bfc-base-2">{item.count}</small>
          </Inline>
        </button>
      ))}
    </Grid>
  )
}

function formatDuration(seconds: number): string {
  if (!seconds) return '0s'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest}s`
}

function Markdown({ text }: { text: string }) {
  return <div className="bf-elements" dangerouslySetInnerHTML={{ __html: marked.parse(text, { async: false }) }} />
}

function DualValueTile({
  label,
  icon,
  primary,
  secondary,
}: {
  label: string
  icon: Parameters<typeof Icon>[0]['icon']
  primary: { value: string; caption: string }
  secondary: { value: string; caption: string }
}) {
  return (
    <Box padding radius background="base-2">
      <Inline gap={12} align="center">
        <Box
          radius="full"
          background="base"
          style={{ width: 40, height: 40, display: 'grid', placeItems: 'center' }}
        >
          <Icon icon={icon} className="bfc-base-2 bf-large" />
        </Box>
        <Inline.Stretch>
          <small className="bfc-base-2">{label}</small>
          <Inline gap={16} align="center">
            <span>
              <span className="bf-h5">{primary.value}</span>{' '}
              <small className="bfc-base-2">{primary.caption}</small>
            </span>
            <span>
              <span className="bf-h5">{secondary.value}</span>{' '}
              <small className="bfc-base-2">{secondary.caption}</small>
            </span>
          </Inline>
        </Inline.Stretch>
      </Inline>
    </Box>
  )
}

function SectionBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box padding radius background="base-2">
      <h5 className="bf-h5" style={{ marginBottom: 16 }}>
        {title}
      </h5>
      {children}
    </Box>
  )
}

const stepIcon: Record<StepType, Parameters<typeof Icon>[0]['icon']> = {
  agent: faBrain,
  chat: faComments,
  tool: faWrench,
  finish: faFlagCheckered,
  info: faCircleInfo,
}

function StepTitle({ index, step }: { index: number; step: RunStep }) {
  return (
    <Inline align="center" gap={8}>
      <small className="bfc-base-2">#{index + 1}</small>
      <Icon icon={stepIcon[step.type]} className="bfc-base-2" />
      <Inline.Stretch>{step.label}</Inline.Stretch>
      <small className="bfc-base-2">{formatDuration(step.durationSec)}</small>
    </Inline>
  )
}

function StepOutput({ step }: { step: RunStep }) {
  if (!step.output) {
    return (
      <small className="bfc-base-2">
        {step.type === 'tool'
          ? 'No input/output was captured for this tool call — Logfire only recorded that it ran.'
          : 'No output captured for this step.'}
      </small>
    )
  }
  if (step.type === 'agent' || step.type === 'chat') {
    return <Markdown text={step.output} />
  }
  return <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{step.output}</p>
}

function TicketRunDetails({ runs }: { runs: TicketRun[] }) {
  return (
    <Grid gap={16} style={{ padding: '4px 0 12px' }}>
      {runs.map((run) => (
        <Box key={run.traceId} padding radius border background="base">
          <Inline align="center" gap={8} style={{ marginBottom: 12 }}>
            <strong>{timeFormatter.format(new Date(run.timestamp))}</strong>
            {run.outcome === 'exception' ? (
              <Badge state="alert">Failed</Badge>
            ) : (
              <Badge state="neutral">Completed</Badge>
            )}
            <span className="bfc-base-2">{formatDuration(run.durationSec)}</span>
            {run.costUsd > 0 && (
              <span className="bfc-base-2">{preciseCostFormatter.format(run.costUsd)}</span>
            )}
          </Inline>

          {run.solution && (
            <Box padding radius background="base-2" style={{ marginBottom: 12 }}>
              <small className="bfc-base-2" style={{ display: 'block', marginBottom: 8 }}>
                Solution proposal
              </small>
              <Markdown text={run.solution} />
            </Box>
          )}

          {run.steps.length > 0 ? (
            <Accordion mode="compact">
              {run.steps.map((step, i) => (
                <Accordion.Item key={i} title={<StepTitle index={i} step={step} />}>
                  <StepOutput step={step} />
                </Accordion.Item>
              ))}
            </Accordion>
          ) : (
            <small className="bfc-base-2">No steps recorded for this run.</small>
          )}
        </Box>
      ))}
    </Grid>
  )
}

interface AsyncModalState<T> {
  title: string
  items: T[] | null
  loading: boolean
  error: string | null
}

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [errorModal, setErrorModal] = useState<AsyncModalState<ErrorExample> | null>(null)
  const [toolFailureModal, setToolFailureModal] = useState<AsyncModalState<ToolFailureExample> | null>(null)
  const [dayLogModal, setDayLogModal] = useState<AsyncModalState<DayLogEntry> | null>(null)
  const [usageFilter, setUsageFilter] = useState<string>('all')
  const [environment, setEnvironment] = useState<Environment>(DEFAULT_ENVIRONMENT)

  const openErrorModal = useCallback(
    (kind: string) => {
      setErrorModal({ title: kind, items: null, loading: true, error: null })
      fetchErrorExamples(kind, environment)
        .then((items) => setErrorModal({ title: kind, items, loading: false, error: null }))
        .catch((e: Error) => setErrorModal({ title: kind, items: null, loading: false, error: e.message }))
    },
    [environment],
  )

  const openToolFailureModal = useCallback(
    (tool: string) => {
      setToolFailureModal({ title: tool, items: null, loading: true, error: null })
      fetchToolFailureExamples(tool, environment)
        .then((items) => setToolFailureModal({ title: tool, items, loading: false, error: null }))
        .catch((e: Error) => setToolFailureModal({ title: tool, items: null, loading: false, error: e.message }))
    },
    [environment],
  )

  const openDayLogModal = useCallback(
    (dayIso: string) => {
      const date = dayIso.slice(0, 10)
      setDayLogModal({ title: date, items: null, loading: true, error: null })
      fetchDayLog(date, environment)
        .then((items) => setDayLogModal({ title: date, items, loading: false, error: null }))
        .catch((e: Error) => setDayLogModal({ title: date, items: null, loading: false, error: e.message }))
    },
    [environment],
  )

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchDashboard(environment)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [environment])

  useEffect(() => {
    load()
  }, [load])

  const dailyUsersData = (data?.dailyUsers ?? []).map((point) => ({
    ...point,
    label: dayFormatter.format(new Date(point.day)),
  }))

  const toolData = data?.tools ?? []
  const modelData = data?.models ?? []
  const costData = (data?.models ?? [])
    .filter((m) => m.costUsd != null)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
  const dailyCostData = (data?.dailyCost ?? []).map((point) => ({
    ...point,
    label: dayFormatter.format(new Date(point.day)),
  }))
  const contextData = (data?.context ?? []).map((c) => ({
    ...c,
    label: c.type === 'none' ? 'No context' : c.type.charAt(0).toUpperCase() + c.type.slice(1),
  }))

  const usageTypes = [...new Set((data?.usage ?? []).map((u) => u.entityType))]
  const filteredUsage = (data?.usage ?? []).filter(
    (u) => usageFilter === 'all' || u.entityType === usageFilter,
  )

  return (
    <div className="bf-page-padding">
      <Inline align="center" gap={12} style={{ marginBottom: 24, flexWrap: 'wrap' }}>
        <Inline.Stretch>
          <h1>Dashboard</h1>
          <p className="bfc-base-2">Live insight from Logfire</p>
        </Inline.Stretch>
        <Button.Group>
          {ENVIRONMENTS.map((env) => (
            <Button key={env} active={environment === env} onClick={() => setEnvironment(env)}>
              {env.charAt(0).toUpperCase() + env.slice(1)}
            </Button>
          ))}
        </Button.Group>
        <Button onClick={load} disabled={loading}>
          <Icon icon={faArrowsRotate} marginRight />
          Refresh
        </Button>
      </Inline>

      {error && (
        <Message state="alert" header="Could not fetch data from Logfire" style={{ marginBottom: 24 }}>
          {error}
        </Message>
      )}

      {loading && !data && (
        <Inline align="center" gap={8}>
          <Icon.Spinner size={24} />
          <span>Loading data …</span>
        </Inline>
      )}

      {data && (
        <Grid gap={24}>
          <Grid cols={1} small={2} large={4} gap={16}>
            <DualValueTile
              label="Response time (today)"
              icon={faStopwatch}
              primary={{ value: formatDuration(data.totals.medianResponseTimeSec), caption: 'median' }}
              secondary={{ value: formatDuration(data.totals.avgResponseTimeSec), caption: 'avg' }}
            />
            <DualValueTile
              label="Cost & tokens (today)"
              icon={faCoins}
              primary={{ value: preciseCostFormatter.format(data.totals.costUsd), caption: 'cost' }}
              secondary={{
                value: compactFormatter.format(data.totals.tokensUsed),
                caption:
                  data.totals.cachedTokens > 0
                    ? `tokens (${compactFormatter.format(data.totals.cachedTokens)} cached)`
                    : 'tokens',
              }}
            />
            <DualValueTile
              label="Usage (today)"
              icon={faComments}
              primary={{ value: compactFormatter.format(data.totals.uniqueUsers), caption: 'unique users' }}
              secondary={{ value: compactFormatter.format(data.totals.uses), caption: 'uses' }}
            />
            <DualValueTile
              label="Solution agent response time (7d)"
              icon={faFlagCheckered}
              primary={{ value: formatDuration(data.totals.solutionMedianResponseTimeSec), caption: 'median' }}
              secondary={{ value: formatDuration(data.totals.solutionAvgResponseTimeSec), caption: 'avg' }}
            />
          </Grid>

          <SectionBox title="LLM cost per day (7d)">
            {dailyCostData.length === 0 ? (
              <Message state="neutral" noIcon>
                No priced LLM calls recorded yet.
              </Message>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={dailyCostData} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="5 5" vertical={false} stroke="var(--bfc-base-c-dimmed)" />
                  <XAxis
                    axisLine={false}
                    tickLine={false}
                    dataKey="label"
                    tick={{ fill: 'var(--bfc-base-c-2)' }}
                    dy={8}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: 'var(--bfc-base-c-2)' }}
                    tickFormatter={(v) => costFormatter.format(v)}
                  />
                  <Tooltip cursor={false} formatter={(v) => costFormatter.format(Number(v))} contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="cost" name="Daily cost" fill="var(--bfc-chill)" radius={4} />
                  <Line
                    type="monotone"
                    dataKey="cumulativeCost"
                    name="Cumulative cost"
                    stroke="var(--bfc-attn)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </SectionBox>

          <Grid cols={1} large={2} gap={24}>
            <SectionBox title="Daily active users (7d)">
              {dailyUsersData.length > 0 && (
                <small className="bfc-base-2" style={{ display: 'block', marginBottom: 8 }}>
                  Click a bar to see that day's log
                </small>
              )}
              {dailyUsersData.length === 0 ? (
                <Message state="neutral" noIcon>
                  No chat activity recorded yet.
                </Message>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={dailyUsersData} margin={{ left: -20 }}>
                    <CartesianGrid strokeDasharray="5 5" vertical={false} stroke="var(--bfc-base-c-dimmed)" />
                    <XAxis
                      axisLine={false}
                      tickLine={false}
                      dataKey="label"
                      tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 11 }}
                      dy={8}
                    />
                    <YAxis axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: 'var(--bfc-base-c-2)' }} />
                    <Tooltip cursor={false} content={<DailyUsersTooltip />} />
                    <Bar
                      dataKey="users"
                      name="Active users"
                      fill="var(--bfc-chill)"
                      radius={4}
                      cursor="pointer"
                      onClick={(entry: { payload?: { day: string } }) => {
                        if (entry.payload) openDayLogModal(entry.payload.day)
                      }}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionBox>

            <SectionBox title="Agent usage by context (7d)">
              {contextData.length === 0 ? (
                <Message state="neutral" noIcon>
                  No context data recorded yet.
                </Message>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={contextData}
                      dataKey="count"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      innerRadius={56}
                      outerRadius={88}
                      paddingAngle={2}
                      cornerRadius={3}
                      stroke="var(--bfc-base-2)"
                      strokeWidth={2}
                    >
                      {contextData.map((entry, i) => (
                        <Cell key={entry.type} fill={contextColor(entry.type, i)} />
                      ))}
                    </Pie>
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
                    <Tooltip contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </SectionBox>
          </Grid>

          <Grid cols={1} large={2} xl={3} gap={24}>
            <SectionBox title="Estimated LLM cost per model (7d)">
              {costData.length === 0 ? (
                <Message state="neutral" noIcon>
                  Logfire has no pricing data for the models used yet (self-hosted/internal
                  models often aren't in its pricing table).
                </Message>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(240, costData.length * 32)}>
                  <BarChart data={costData} layout="vertical" margin={{ left: 20 }}>
                    <CartesianGrid strokeDasharray="5 5" horizontal={false} stroke="var(--bfc-base-c-dimmed)" />
                    <XAxis
                      type="number"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: 'var(--bfc-base-c-2)' }}
                      tickFormatter={(v) => costFormatter.format(v)}
                    />
                    <YAxis
                      type="category"
                      dataKey="model"
                      axisLine={false}
                      tickLine={false}
                      width={160}
                      tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 12 }}
                    />
                    <Tooltip cursor={false} formatter={(v) => costFormatter.format(Number(v))} contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
                    <Bar dataKey="costUsd" name="Cost" fill="var(--bfc-chill)" radius={4} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionBox>

            <SectionBox title="Most used tools (7d)">
              {toolData.length === 0 ? (
                <Message state="neutral" noIcon>
                  No tool calls recorded yet.
                </Message>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(240, toolData.length * 32)}>
                  <BarChart data={toolData} layout="vertical" margin={{ left: 20 }}>
                    <CartesianGrid strokeDasharray="5 5" horizontal={false} stroke="var(--bfc-base-c-dimmed)" />
                    <XAxis type="number" axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: 'var(--bfc-base-c-2)' }} />
                    <YAxis
                      type="category"
                      dataKey="tool"
                      axisLine={false}
                      tickLine={false}
                      width={220}
                      tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 12 }}
                    />
                    <Tooltip cursor={false} contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
                    <Bar dataKey="count" name="Calls" fill="var(--bfc-chill)" radius={4} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionBox>

            <SectionBox title="Token usage per model (7d)">
              {modelData.length === 0 ? (
                <Message state="neutral" noIcon>
                  No model calls recorded yet.
                </Message>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(240, modelData.length * 32)}>
                  <BarChart data={modelData} layout="vertical" margin={{ left: 20 }}>
                    <CartesianGrid strokeDasharray="5 5" horizontal={false} stroke="var(--bfc-base-c-dimmed)" />
                    <XAxis type="number" axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: 'var(--bfc-base-c-2)' }} />
                    <YAxis
                      type="category"
                      dataKey="model"
                      axisLine={false}
                      tickLine={false}
                      width={160}
                      tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 12 }}
                    />
                    <Tooltip cursor={false} contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="inputTokens" name="Input" stackId="tokens" fill="var(--bfc-chill)" radius={0} />
                    <Bar dataKey="outputTokens" name="Output" stackId="tokens" fill="var(--bfc-attn)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionBox>
          </Grid>

          <SectionBox title="Usage log (7d)">
            <Inline align="center" gap={8} style={{ marginBottom: 16, flexWrap: 'wrap' }}>
              <Button.Group>
                <Button active={usageFilter === 'all'} onClick={() => setUsageFilter('all')}>
                  All ({data.usage.length})
                </Button>
                {usageTypes.map((type) => (
                  <Button key={type} active={usageFilter === type} onClick={() => setUsageFilter(type)}>
                    {type === 'none' ? 'No context' : type.charAt(0).toUpperCase() + type.slice(1)} (
                    {data.usage.filter((u) => u.entityType === type).length})
                  </Button>
                ))}
              </Button.Group>
            </Inline>
            {filteredUsage.length === 0 ? (
              <Message state="neutral" noIcon>
                No usage recorded for this filter yet.
              </Message>
            ) : (
              <Table key={usageFilter}>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell></Table.HeaderCell>
                    <Table.HeaderCell>Timestamp</Table.HeaderCell>
                    <Table.HeaderCell>Type</Table.HeaderCell>
                    <Table.HeaderCell>Reference</Table.HeaderCell>
                    <Table.HeaderCell>Uses</Table.HeaderCell>
                    <Table.HeaderCell>Solution triggers</Table.HeaderCell>
                    <Table.HeaderCell>Avg duration</Table.HeaderCell>
                    <Table.HeaderCell>Cost</Table.HeaderCell>
                    <Table.HeaderCell>Outcome</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {filteredUsage.map((row) => {
                    const link = entityLink(row.entityType, row.entityId)
                    return (
                      <Table.Row
                        key={`${row.entityType}-${row.entityId ?? 'none'}`}
                        content={row.runs.length > 0 ? <TicketRunDetails runs={row.runs} /> : undefined}
                      >
                        <Table.Cell>{formatUsageTimestamp(row.lastSeen)}</Table.Cell>
                        <Table.Cell>
                          <Badge state={entityBadgeState[row.entityType] ?? 'neutral'}>{row.entityType}</Badge>
                        </Table.Cell>
                        <Table.Cell>
                          {link ? (
                            <a href={link} target="_blank" rel="noreferrer">
                              #{row.entityId}
                            </a>
                          ) : (
                            (row.entityId ?? '—')
                          )}
                        </Table.Cell>
                        <Table.Cell>{row.uses}</Table.Cell>
                        <Table.Cell>{row.triggers || '—'}</Table.Cell>
                        <Table.Cell>{row.triggers > 0 ? formatDuration(row.avgDurationSec) : '—'}</Table.Cell>
                        <Table.Cell>
                          {row.costUsd != null ? preciseCostFormatter.format(row.costUsd) : '—'}
                        </Table.Cell>
                        <Table.Cell>
                          {row.triggers === 0 ? (
                            '—'
                          ) : row.exceptions > 0 ? (
                            <Badge state="alert">{row.exceptions} failed</Badge>
                          ) : (
                            <Badge state="neutral">OK</Badge>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    )
                  })}
                </Table.Body>
              </Table>
            )}
          </SectionBox>

          <Grid cols={1} large={2} gap={24}>
            <SectionBox title="Errors (7d)">
              <Inline align="center" gap={12} style={{ marginBottom: data.errors.byKind.length > 0 ? 16 : 0 }}>
                <Icon icon={faTriangleExclamation} className="bfc-alert bf-large" />
                <span className="bf-h5">{compactFormatter.format(data.errors.total)} errors</span>
              </Inline>
              {data.errors.byKind.length > 0 && (
                <BreakdownBars
                  items={data.errors.byKind.map((e) => ({ label: e.kind, count: e.count }))}
                  onSelect={openErrorModal}
                />
              )}
            </SectionBox>

            <SectionBox title="Tool call failures (7d)">
              {data.toolFailures.length === 0 ? (
                <Message state="neutral" noIcon>
                  No tool call failures recorded.
                </Message>
              ) : (
                <BreakdownBars
                  items={data.toolFailures.map((t) => ({ label: t.tool, count: t.count }))}
                  onSelect={openToolFailureModal}
                />
              )}
            </SectionBox>
          </Grid>

          <SectionBox title="Recent events (24h)">
            {data.recent.length === 0 ? (
              <Message state="neutral" noIcon>
                No events to show yet.
              </Message>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Timestamp</Table.HeaderCell>
                    <Table.HeaderCell>Service</Table.HeaderCell>
                    <Table.HeaderCell>Level</Table.HeaderCell>
                    <Table.HeaderCell>Message</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.recent.map((row, i) => (
                    <Table.Row key={i}>
                      <Table.Cell>{timeFormatter.format(new Date(row.time))}</Table.Cell>
                      <Table.Cell>{row.service}</Table.Cell>
                      <Table.Cell>
                        <Badge state={levelBadgeState[row.level]}>{row.level}</Badge>
                      </Table.Cell>
                      <Table.Cell>{row.message}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </SectionBox>
        </Grid>
      )}

      <Modal
        isOpen={errorModal != null}
        onRequestClose={() => setErrorModal(null)}
        header={errorModal?.title}
        width={700}
      >
        {errorModal?.loading && (
          <Inline align="center" gap={8}>
            <Icon.Spinner size={20} />
            <span>Loading examples …</span>
          </Inline>
        )}
        {errorModal?.error && (
          <Message state="alert" noIcon>
            {errorModal.error}
          </Message>
        )}
        {errorModal?.items && (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Time</Table.HeaderCell>
                <Table.HeaderCell>Service</Table.HeaderCell>
                <Table.HeaderCell>Message</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {errorModal.items.map((e, i) => (
                <Table.Row key={i}>
                  <Table.Cell>{timeFormatter.format(new Date(e.time))}</Table.Cell>
                  <Table.Cell>{e.service}</Table.Cell>
                  <Table.Cell style={{ wordBreak: 'break-word' }}>{e.message}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Modal>

      <Modal
        isOpen={toolFailureModal != null}
        onRequestClose={() => setToolFailureModal(null)}
        header={toolFailureModal?.title}
        width={700}
      >
        {toolFailureModal?.loading && (
          <Inline align="center" gap={8}>
            <Icon.Spinner size={20} />
            <span>Loading examples …</span>
          </Inline>
        )}
        {toolFailureModal?.error && (
          <Message state="alert" noIcon>
            {toolFailureModal.error}
          </Message>
        )}
        {toolFailureModal?.items && (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Time</Table.HeaderCell>
                <Table.HeaderCell>Kind</Table.HeaderCell>
                <Table.HeaderCell>Detail</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {toolFailureModal.items.map((t, i) => (
                <Table.Row key={i}>
                  <Table.Cell>{timeFormatter.format(new Date(t.time))}</Table.Cell>
                  <Table.Cell>
                    <Badge state={t.kind === 'timeout' ? 'warning' : 'alert'}>{t.kind}</Badge>
                  </Table.Cell>
                  <Table.Cell style={{ wordBreak: 'break-word' }}>{t.detail}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Modal>

      <Modal
        isOpen={dayLogModal != null}
        onRequestClose={() => setDayLogModal(null)}
        header={dayLogModal ? `Activity log · ${dayLogModal.title}` : undefined}
        width={700}
      >
        {dayLogModal?.loading && (
          <Inline align="center" gap={8}>
            <Icon.Spinner size={20} />
            <span>Loading log …</span>
          </Inline>
        )}
        {dayLogModal?.error && (
          <Message state="alert" noIcon>
            {dayLogModal.error}
          </Message>
        )}
        {dayLogModal?.items && (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Time</Table.HeaderCell>
                <Table.HeaderCell>User</Table.HeaderCell>
                <Table.HeaderCell>Context</Table.HeaderCell>
                <Table.HeaderCell>Model</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {dayLogModal.items.map((entry, i) => (
                <Table.Row key={i}>
                  <Table.Cell>{timeFormatter.format(new Date(entry.time))}</Table.Cell>
                  <Table.Cell>{entry.userId}</Table.Cell>
                  <Table.Cell>{entry.entityType}</Table.Cell>
                  <Table.Cell>{entry.model}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Modal>
    </div>
  )
}

export default Dashboard
