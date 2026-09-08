import { Component, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
  faClock,
  faCoins,
  faComments,
  faFlagCheckered,
  faMagnifyingGlass,
  faShieldHalved,
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
import Dropdown from '@intility/bifrost-react/Dropdown'
import Input from '@intility/bifrost-react/Input'
import Pagination from '@intility/bifrost-react/Pagination'
import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  fetchDashboard,
  fetchDayLog,
  fetchErrorExamples,
  fetchNoAnswerExamples,
  fetchSecurityJudgeExamples,
  fetchToolFailureExamples,
  fetchTicketInfo,
  fetchUsageErrors,
  fetchUsageRuns,
  type DashboardData,
  type DayLogEntry,
  type Environment,
  type ErrorExample,
  type NoAnswerExample,
  type RunStep,
  type SecurityJudgeExample,
  type StepType,
  type TicketInfo,
  type TimeRange,
  type TicketRun,
  type ToolFailureExample,
  type UsageErrorExample,
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

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'short',
  timeStyle: 'medium',
})

interface TimeRangePreset {
  label: string
  minutesBack: number
}

const TIME_PRESETS: TimeRangePreset[] = [
  { label: 'Last 5 minutes', minutesBack: 5 },
  { label: 'Last 15 minutes', minutesBack: 15 },
  { label: 'Last hour', minutesBack: 60 },
  { label: 'Last 24 hours', minutesBack: 60 * 24 },
  { label: 'Last 7 days', minutesBack: 60 * 24 * 7 },
]

function presetRange(minutesBack: number): TimeRange {
  const max = new Date()
  const min = new Date(max.getTime() - minutesBack * 60 * 1000)
  return { minTimestamp: min.toISOString(), maxTimestamp: max.toISOString() }
}

const DEFAULT_TIME_RANGE = presetRange(60 * 24 * 7)

function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInputValue(value: string): string {
  return new Date(value).toISOString()
}

const rangeFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' })

function formatRangeLabel(range: TimeRange, activePresetLabel: string | null): string {
  if (activePresetLabel) return activePresetLabel
  return `${rangeFormatter.format(new Date(range.minTimestamp))} – ${rangeFormatter.format(new Date(range.maxTimestamp))}`
}

function TimeRangePicker({ value, onChange }: { value: TimeRange; onChange: (range: TimeRange) => void }) {
  const [activePreset, setActivePreset] = useState<string | null>('Last 7 days')
  const [customFrom, setCustomFrom] = useState(() => toLocalInputValue(value.minTimestamp))
  const [customTo, setCustomTo] = useState(() => toLocalInputValue(value.maxTimestamp))

  const applyPreset = (preset: TimeRangePreset) => {
    const range = presetRange(preset.minutesBack)
    onChange(range)
    setActivePreset(preset.label)
    setCustomFrom(toLocalInputValue(range.minTimestamp))
    setCustomTo(toLocalInputValue(range.maxTimestamp))
  }

  const applyCustom = () => {
    if (!customFrom || !customTo) return
    const minTimestamp = fromLocalInputValue(customFrom)
    const maxTimestamp = fromLocalInputValue(customTo)
    if (new Date(minTimestamp) >= new Date(maxTimestamp)) return
    onChange({ minTimestamp, maxTimestamp })
    setActivePreset(null)
  }

  return (
    <Dropdown
      placement="bottom-end"
      content={
        <Box padding style={{ minWidth: 260 }}>
          <Grid gap={4} style={{ marginBottom: 12 }}>
            {TIME_PRESETS.map((preset) => (
              <Button
                key={preset.label}
                variant={activePreset === preset.label ? 'filled' : 'flat'}
                style={{ textAlign: 'left', fontWeight: 'normal', justifyContent: 'flex-start' }}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </Button>
            ))}
          </Grid>
          <hr />
          <Grid gap={8} style={{ marginTop: 12 }}>
            <small className="bfc-base-2">Custom range</small>
            <Input
              label="From"
              type="datetime-local"
              small
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <Input
              label="To"
              type="datetime-local"
              small
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
            <Button small onClick={applyCustom}>
              Apply
            </Button>
          </Grid>
        </Box>
      }
    >
      <Button>
        <Icon icon={faClock} marginRight />
        {formatRangeLabel(value, activePreset)}
      </Button>
    </Dropdown>
  )
}

const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact' })

const costFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
  useGrouping: false,
})

const preciseCostFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 1,
  useGrouping: false,
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
  payload?: { payload: { label: string; users: number; messages: number; cumulativeUsers: number } }[]
}) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div style={{ ...tooltipContentStyle, padding: '8px 12px' }}>
      <div style={{ ...tooltipLabelStyle, marginBottom: 4 }}>{point.label}</div>
      <div style={tooltipItemStyle}>{point.users} active users</div>
      <div style={tooltipItemStyle}>{point.messages} messages</div>
      <div style={tooltipItemStyle}>{point.cumulativeUsers} cumulative users</div>
    </div>
  )
}

function ModelCostTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: { payload: { model: string; costUsd: number; inputTokens: number; outputTokens: number } }[]
}) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div style={{ ...tooltipContentStyle, padding: '8px 12px' }}>
      <div style={{ ...tooltipLabelStyle, marginBottom: 4 }}>{point.model}</div>
      <div style={tooltipItemStyle}>{costFormatter.format(point.costUsd)} cost</div>
      <div style={tooltipItemStyle}>{compactFormatter.format(point.inputTokens)} input tokens</div>
      <div style={tooltipItemStyle}>{compactFormatter.format(point.outputTokens)} output tokens</div>
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
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest}s`
}

function Markdown({ text }: { text: string }) {
  return <div className="bf-elements" dangerouslySetInnerHTML={{ __html: marked.parse(text, { async: false }) }} />
}

function Tile({
  label,
  icon,
  value,
  sub,
  onClick,
  alert,
}: {
  label: string
  icon: Parameters<typeof Icon>[0]['icon']
  value: string
  sub?: string
  onClick?: () => void
  alert?: boolean
}) {
  return (
    <Box
      padding
      radius
      background="base-2"
      style={onClick ? { cursor: 'pointer', transition: 'box-shadow 0.15s' } : undefined}
      {...(onClick ? { onClick } : {})}
    >
      <Inline gap={12} align="center">
        <Box
          radius="full"
          background="base"
          style={{ width: 40, height: 40, display: 'grid', placeItems: 'center' }}
        >
          <Icon icon={icon} className={alert ? 'bfc-alert bf-large' : 'bfc-base-2 bf-large'} />
        </Box>
        <Inline.Stretch>
          <small className="bfc-base-2">{label}</small>
          <div>
            <span className="bf-h5">{value}</span>
            {sub && (
              <>
                {' '}
                <small className="bfc-base-2">{sub}</small>
              </>
            )}
          </div>
        </Inline.Stretch>
      </Inline>
    </Box>
  )
}

function ToolTokenTable({
  tools,
  llmCalls,
}: {
  tools: DashboardData['tools']
  llmCalls: DashboardData['llmCalls']
}) {
  const [page, setPage] = useState(1)
  const pageSize = 5

  const rows = [
    ...tools.map((t) => ({
      name: t.tool,
      type: 'Tool' as const,
      calls: t.calls,
      totalDurationSec: t.totalDurationSec,
      avgDurationSec: t.avgDurationSec,
      errors: t.errors,
      tokens: null as number | null,
    })),
    ...llmCalls.map((l) => ({
      name: l.model,
      type: 'LLM' as const,
      calls: l.calls,
      totalDurationSec: l.totalDurationSec,
      avgDurationSec: l.calls > 0 ? l.totalDurationSec / l.calls : 0,
      errors: 0,
      tokens: l.inputTokens + l.outputTokens,
    })),
  ].sort((a, b) => b.totalDurationSec - a.totalDurationSec)

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const paged = rows.slice((page - 1) * pageSize, page * pageSize)

  if (rows.length === 0) {
    return (
      <Message state="neutral" noIcon>
        No tool or LLM calls recorded yet.
      </Message>
    )
  }

  return (
    <Grid gap={12}>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Name</Table.HeaderCell>
            <Table.HeaderCell>Type</Table.HeaderCell>
            <Table.HeaderCell>Calls</Table.HeaderCell>
            <Table.HeaderCell>Total time</Table.HeaderCell>
            <Table.HeaderCell>Avg time</Table.HeaderCell>
            <Table.HeaderCell>Tokens</Table.HeaderCell>
            <Table.HeaderCell>Errors</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {paged.map((row, i) => (
            <Table.Row key={`${row.type}-${row.name}-${i}`}>
              <Table.Cell>{row.name}</Table.Cell>
              <Table.Cell>
                <Badge state={row.type === 'Tool' ? 'neutral' : 'chill'}>{row.type}</Badge>
              </Table.Cell>
              <Table.Cell>{row.calls}</Table.Cell>
              <Table.Cell>{formatDuration(row.totalDurationSec)}</Table.Cell>
              <Table.Cell>{formatDuration(row.avgDurationSec)}</Table.Cell>
              <Table.Cell>{row.tokens != null ? compactFormatter.format(row.tokens) : '—'}</Table.Cell>
              <Table.Cell>
                {row.errors > 0 ? (
                  <Badge state="alert">{row.errors}</Badge>
                ) : (
                  <Badge state="neutral">0</Badge>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {totalPages > 1 && (
        <Inline align="center" style={{ justifyContent: 'center' }}>
          <Pagination totalPages={totalPages} currentPage={page} onChange={setPage} />
        </Inline>
      )}
    </Grid>
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
      <Icon icon={step.isError ? faTriangleExclamation : stepIcon[step.type]} className={step.isError ? 'bfc-alert' : 'bfc-base-2'} />
      <Inline.Stretch>
        <span className={step.isError ? 'bfc-alert' : undefined}>{step.label}</span>
      </Inline.Stretch>
      {step.isError && <Badge state="alert">Failed</Badge>}
      <small className="bfc-base-2">{formatDuration(step.durationSec)}</small>
    </Inline>
  )
}

function StepOutput({ step }: { step: RunStep }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {step.isError && step.exceptionMessage && (
        <Box padding radius background="base-2" style={{ borderLeft: '3px solid var(--bfc-alert)' }}>
          <Inline align="center" gap={8}>
            {step.exceptionType && <Badge state="alert">{step.exceptionType}</Badge>}
            <span className="bfc-alert" style={{ wordBreak: 'break-word' }}>{step.exceptionMessage}</span>
          </Inline>
        </Box>
      )}
      {step.output ? (
        step.type === 'agent' || step.type === 'chat' ? (
          <Markdown text={step.output} />
        ) : step.type === 'tool' ? (
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>{step.output}</pre>
        ) : (
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{step.output}</p>
        )
      ) : !step.isError ? (
        <small className="bfc-base-2">
          {step.type === 'tool'
            ? 'No input/output was captured for this tool call — Logfire only recorded that it ran.'
            : 'No output captured for this step.'}
        </small>
      ) : null}
    </div>
  )
}

/** Buckets steps into the handful of things a reader actually wants to compare: initial
 * data load, all reasoning/LLM calls combined, and one bucket per distinct tool (repeat
 * calls to the same tool add up rather than each getting their own bar). Failed steps are
 * shown in their own section instead, so they're excluded here. */
function groupStepsForChart(steps: RunStep[]): { name: string; duration: number }[] {
  const buckets = new Map<string, { duration: number; count: number }>()
  for (const step of steps) {
    if (step.isError) continue
    const key =
      step.type === 'agent' || step.type === 'chat' ? 'Reasoning'
      : step.type === 'tool' ? step.label
      : step.type === 'finish' ? 'Finish'
      : 'Initial data'
    const entry = buckets.get(key) ?? { duration: 0, count: 0 }
    entry.duration += step.durationSec
    entry.count += 1
    buckets.set(key, entry)
  }
  return [...buckets.entries()]
    .map(([name, { duration, count }]) => ({
      name: `${name.length > 24 ? name.slice(0, 24) + '…' : name}${count > 1 ? ` (${count}×)` : ''}`,
      duration: Math.round(duration * 10) / 10,
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5)
}

function TicketRunDetails({ runs }: { runs: TicketRun[] }) {
  return (
    <Grid gap={12} style={{ padding: '4px 0 12px' }}>
      {runs.map((run) => {
        const failedSteps = run.steps.filter((s) => s.isError)
        const hasSteps = run.steps.length > 0
        const chartData = groupStepsForChart(run.steps)
        return (
          <Box key={run.traceId} padding radius border background="base">
            <Inline align="center" gap={8} style={{ marginBottom: 12 }}>
              <strong>{timeFormatter.format(new Date(run.timestamp))}</strong>
              {run.outcome === 'exception' ? (
                <Badge state="alert">Failed</Badge>
              ) : (
                <Badge state="success">Completed</Badge>
              )}
              <span className="bfc-base-2">{formatDuration(run.durationSec)}</span>
              {run.costUsd > 0 && (
                <span className="bfc-base-2">{preciseCostFormatter.format(run.costUsd)}</span>
              )}
            </Inline>

            {run.solution && (
              <Box padding radius background="base-2" style={{ marginBottom: 12 }}>
                <small className="bfc-base-2" style={{ display: 'block', marginBottom: 8 }}>Output</small>
                <Markdown text={run.solution} />
              </Box>
            )}

            {failedSteps.length > 0 && (
              <Accordion mode="compact" style={{ marginBottom: 12 }}>
                <Accordion.Item
                  title={
                    <Inline align="center" gap={8}>
                      <Icon icon={faTriangleExclamation} className="bfc-alert" />
                      <span className="bfc-alert" style={{ fontWeight: 600 }}>
                        {failedSteps.length} failed step{failedSteps.length > 1 ? 's' : ''}
                      </span>
                    </Inline>
                  }
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {failedSteps.map((step, i) => (
                      <div key={i}>
                        <Inline align="center" gap={8}>
                          <span className="bfc-alert" style={{ fontWeight: 600 }}>{step.label}</span>
                          {step.exceptionType && <Badge state="alert">{step.exceptionType}</Badge>}
                        </Inline>
                        {step.exceptionMessage && (
                          <small className="bfc-alert" style={{ display: 'block', marginTop: 2, wordBreak: 'break-word' }}>
                            {step.exceptionMessage}
                          </small>
                        )}
                      </div>
                    ))}
                  </div>
                </Accordion.Item>
              </Accordion>
            )}

            {chartData.length > 0 && (
              <Box padding radius background="base-2" style={{ marginBottom: 12 }}>
                <small className="bfc-base-2" style={{ display: 'block', marginBottom: 8 }}>Time breakdown</small>
                <ResponsiveContainer width="100%" height={Math.max(60, chartData.length * 28)}>
                  <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 30 }}>
                    <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 10 }} />
                    <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 10 }} width={140} />
                    <Tooltip cursor={false} formatter={(v) => [`${v}s`, 'Duration']} contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
                    <Bar dataKey="duration" name="Duration" fill="var(--bfc-chill)" radius={3} />
                  </BarChart>
                </ResponsiveContainer>
              </Box>
            )}

            {hasSteps ? (
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
        )
      })}
    </Grid>
  )
}

interface UsageRunsState {
  items: TicketRun[] | null
  loading: boolean
  error: string | null
}

interface TicketInfoState {
  item: TicketInfo | null
  loading: boolean
  error: string | null
}

function TicketInfoPanel({ ticketInfo }: { ticketInfo: TicketInfoState | undefined }) {
  if (!ticketInfo || ticketInfo.loading) {
    return (
      <Inline align="center" gap={8}>
        <Icon.Spinner size={16} />
        <span className="bfc-base-2">Loading ticket info …</span>
      </Inline>
    )
  }
  if (ticketInfo.error) {
    return (
      <Message state="alert" noIcon>
        {ticketInfo.error}
      </Message>
    )
  }
  if (!ticketInfo.item) {
    return <small className="bfc-base-2">No ticket info found in DWH.</small>
  }
  const t = ticketInfo.item
  const fields: [string, string | null][] = [
    ['Category', t.categoryFullName ?? t.categoryName],
    ['Implementation', t.implementationName],
    ['Company', t.companyName],
    ['Owner', t.owner],
    ['Status', t.status],
    ['Priority', t.priority],
  ]
  return (
    <Grid gap={4}>
      <strong>{t.title}</strong>
      <Inline gap={16} style={{ flexWrap: 'wrap' }}>
        {fields
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <span key={label}>
              <span className="bfc-base-2">{label}:</span> {value}
            </span>
          ))}
      </Inline>
    </Grid>
  )
}

/** Catches a render-time crash in `children` and shows the error instead of
 * unmounting the whole page (React has no default recovery from a thrown
 * render). Scope it around any subtree fed by data we don't fully control —
 * a chart, a modal body, a lazily-mounted row panel. */
class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`Failed to render ${this.props.label}:`, error)
  }

  render() {
    if (this.state.error) {
      return (
        <Message state="alert" noIcon>
          Could not display {this.props.label} ({this.state.error.message}).
        </Message>
      )
    }
    return this.props.children
  }
}

function UsageRowDetails({
  solutionRuns,
  chatRuns,
  ticketInfo,
}: {
  solutionRuns: TicketRun[]
  chatRuns: UsageRunsState | undefined
  ticketInfo: TicketInfoState | undefined
}) {
  return (
    <Grid gap={16} style={{ padding: '4px 0 12px' }}>
      {ticketInfo && (
        <Box padding radius background="base-2">
          <TicketInfoPanel ticketInfo={ticketInfo} />
        </Box>
      )}

      {solutionRuns.length > 0 && (
        <Box>
          <small className="bfc-base-2" style={{ display: 'block', marginBottom: 8 }}>
            Solution agent runs
          </small>
          <TicketRunDetails runs={solutionRuns} />
        </Box>
      )}

      <Box>
        <small className="bfc-base-2" style={{ display: 'block', marginBottom: 8 }}>
          Chat exchanges
        </small>
        {!chatRuns || chatRuns.loading ? (
          <Inline align="center" gap={8}>
            <Icon.Spinner size={16} />
            <span className="bfc-base-2">Loading chat history …</span>
          </Inline>
        ) : chatRuns.error ? (
          <Message state="alert" noIcon>
            {chatRuns.error}
          </Message>
        ) : chatRuns.items && chatRuns.items.length > 0 ? (
          <TicketRunDetails runs={chatRuns.items} />
        ) : (
          <small className="bfc-base-2">No chat exchanges recorded.</small>
        )}
      </Box>
    </Grid>
  )
}

interface AsyncModalState<T> {
  title: string
  items: T[] | null
  loading: boolean
  error: string | null
}

function DailyActivityTabs({
  dailyCostData,
  dailyUsersData,
  dailyUsageByContextData,
  dailyUsageByContextTypes,
  openDayLogModal,
}: {
  dailyCostData: { label: string; cost: number; cumulativeCost: number }[]
  dailyUsersData: { label: string; users: number; messages: number; cumulativeUsers: number; day: string }[]
  dailyUsageByContextData: Record<string, number | string>[]
  dailyUsageByContextTypes: string[]
  openDayLogModal: (day: string) => void
}) {
  const [tab, setTab] = useState<'cost' | 'users' | 'context'>('cost')
  return (
    <div>
      <Inline style={{ marginBottom: 16, justifyContent: 'flex-end' }}>
        <Button.Group>
          <Button active={tab === 'cost'} onClick={() => setTab('cost')}>Cost</Button>
          <Button active={tab === 'users'} onClick={() => setTab('users')}>Users</Button>
          <Button active={tab === 'context'} onClick={() => setTab('context')}>Usage by context</Button>
        </Button.Group>
      </Inline>
      {tab === 'cost' && (
        dailyCostData.length === 0 ? (
          <Message state="neutral" noIcon>No priced LLM calls recorded yet.</Message>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={dailyCostData} margin={{ left: -10 }}>
              <CartesianGrid strokeDasharray="5 5" vertical={false} stroke="var(--bfc-base-c-dimmed)" />
              <XAxis axisLine={false} tickLine={false} dataKey="label" tick={{ fill: 'var(--bfc-base-c-2)' }} dy={8} />
              <YAxis axisLine={false} tickLine={false} tick={{ fill: 'var(--bfc-base-c-2)' }} tickFormatter={(v) => costFormatter.format(v)} />
              <Tooltip cursor={false} formatter={(v) => costFormatter.format(Number(v))} contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="cost" name="Daily cost" fill="var(--bfc-chill)" radius={4} />
              <Line type="monotone" dataKey="cumulativeCost" name="Cumulative cost" stroke="var(--bfc-attn)" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        )
      )}
      {tab === 'users' && (
        dailyUsersData.length === 0 ? (
          <Message state="neutral" noIcon>No chat activity recorded yet.</Message>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={dailyUsersData} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="5 5" vertical={false} stroke="var(--bfc-base-c-dimmed)" />
              <XAxis axisLine={false} tickLine={false} dataKey="label" tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 11 }} dy={8} />
              <YAxis axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: 'var(--bfc-base-c-2)' }} />
              <Tooltip cursor={false} content={<DailyUsersTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
              <Bar dataKey="users" name="Daily active users" fill="var(--bfc-chill)" radius={4} cursor="pointer" onClick={(entry: { payload?: { day: string } }) => { if (entry.payload) openDayLogModal(entry.payload.day) }} />
              <Line type="monotone" dataKey="cumulativeUsers" name="Cumulative users" stroke="var(--bfc-attn)" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        )
      )}
      {tab === 'context' && (
        dailyUsageByContextData.length === 0 ? (
          <Message state="neutral" noIcon>No usage data recorded yet.</Message>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={dailyUsageByContextData} margin={{ left: -10 }}>
              <CartesianGrid strokeDasharray="5 5" vertical={false} stroke="var(--bfc-base-c-dimmed)" />
              <XAxis axisLine={false} tickLine={false} dataKey="label" tick={{ fill: 'var(--bfc-base-c-2)' }} dy={8} />
              <YAxis axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: 'var(--bfc-base-c-2)' }} />
              <Tooltip contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
              {dailyUsageByContextTypes.map((type) => (
                <Bar key={type} dataKey={type} name={type === 'none' ? 'No context' : type.charAt(0).toUpperCase() + type.slice(1)} fill={contextColor(type, dailyUsageByContextTypes.indexOf(type))} radius={4} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )
      )}
    </div>
  )
}

function ModelToolTabs({
  modelData,
  tools,
  llmCalls,
}: {
  modelData: DashboardData['models']
  tools: DashboardData['tools']
  llmCalls: DashboardData['llmCalls']
}) {
  const [tab, setTab] = useState<'models' | 'tools'>('models')
  return (
    <div>
      <Inline style={{ marginBottom: 16, justifyContent: 'flex-end' }}>
        <Button.Group>
          <Button active={tab === 'models'} onClick={() => setTab('models')}>Models</Button>
          <Button active={tab === 'tools'} onClick={() => setTab('tools')}>Tools</Button>
        </Button.Group>
      </Inline>
      {tab === 'models' ? (
        modelData.length === 0 ? (
          <Message state="neutral" noIcon>No model calls recorded yet.</Message>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(200, modelData.length * 32)}>
            <BarChart data={modelData} layout="vertical" margin={{ left: 20 }}>
              <CartesianGrid strokeDasharray="5 5" horizontal={false} stroke="var(--bfc-base-c-dimmed)" />
              <XAxis type="number" axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: 'var(--bfc-base-c-2)' }} />
              <YAxis type="category" dataKey="model" axisLine={false} tickLine={false} width={160} tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 12 }} />
              <Tooltip cursor={false} content={<ModelCostTooltip />} />
              <Bar dataKey="calls" name="Calls" fill="var(--bfc-chill)" radius={4} />
            </BarChart>
          </ResponsiveContainer>
        )
      ) : (
        <ToolTokenTable tools={tools} llmCalls={llmCalls} />
      )}
    </div>
  )
}

function ContextToolsTabs({
  contextData,
  toolData,
}: {
  contextData: { type: string; count: number; label: string }[]
  toolData: DashboardData['tools']
}) {
  const [tab, setTab] = useState<'context' | 'tools'>('context')
  return (
    <div>
      <Inline style={{ marginBottom: 16, justifyContent: 'flex-end' }}>
        <Button.Group>
          <Button active={tab === 'context'} onClick={() => setTab('context')}>Context</Button>
          <Button active={tab === 'tools'} onClick={() => setTab('tools')}>Most used tools</Button>
        </Button.Group>
      </Inline>
      {tab === 'context' ? (
        contextData.length === 0 ? (
          <Message state="neutral" noIcon>No context data recorded yet.</Message>
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
        )
      ) : toolData.length === 0 ? (
        <Message state="neutral" noIcon>No tool calls recorded yet.</Message>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(240, toolData.length * 32)}>
          <BarChart data={toolData} layout="vertical" margin={{ left: 20 }}>
            <CartesianGrid strokeDasharray="5 5" horizontal={false} stroke="var(--bfc-base-c-dimmed)" />
            <XAxis type="number" axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: 'var(--bfc-base-c-2)' }} />
            <YAxis type="category" dataKey="tool" axisLine={false} tickLine={false} width={220} tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 12 }} />
            <Tooltip cursor={false} contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
            <Bar dataKey="calls" name="Calls" fill="var(--bfc-chill)" radius={4} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

function IssuesTabs({
  errors,
  toolFailures,
  securityJudge,
  toolFailureCategory,
  setToolFailureCategory,
  agentToolFailures,
  directToolFailures,
  selectedToolFailures,
  openErrorModal,
  openToolFailureModal,
  openSecurityJudgeModal,
}: {
  errors: DashboardData['errors']
  toolFailures: DashboardData['toolFailures']
  securityJudge: DashboardData['securityJudge']
  toolFailureCategory: 'agent' | 'direct'
  setToolFailureCategory: (c: 'agent' | 'direct') => void
  agentToolFailures: DashboardData['toolFailures']
  directToolFailures: DashboardData['toolFailures']
  selectedToolFailures: DashboardData['toolFailures']
  openErrorModal: (kind: string) => void
  openToolFailureModal: (tool: string, category: 'agent' | 'direct') => void
  openSecurityJudgeModal: (kind: string) => void
}) {
  const [tab, setTab] = useState<'errors' | 'toolFailures' | 'security'>('errors')
  return (
    <div>
      <Inline style={{ marginBottom: 16, justifyContent: 'flex-end' }}>
        <Button.Group>
          <Button active={tab === 'errors'} onClick={() => setTab('errors')}>
            <Icon icon={faTriangleExclamation} marginRight /> Errors ({errors.total})
          </Button>
          <Button active={tab === 'toolFailures'} onClick={() => setTab('toolFailures')}>
            <Icon icon={faWrench} marginRight /> Tool failures ({toolFailures.length})
          </Button>
          <Button active={tab === 'security'} onClick={() => setTab('security')}>
            <Icon icon={faShieldHalved} marginRight /> Security blocks ({securityJudge.total})
          </Button>
        </Button.Group>
      </Inline>
      {tab === 'errors' && (
        errors.byKind.length === 0 ? (
          <Message state="neutral" noIcon>No errors recorded.</Message>
        ) : (
          <BreakdownBars items={errors.byKind.map((e) => ({ label: e.kind, count: e.count }))} onSelect={openErrorModal} />
        )
      )}
      {tab === 'toolFailures' && (
        <>
          <Inline style={{ marginBottom: 16, justifyContent: 'flex-end' }}>
            <Button.Group>
              <Button active={toolFailureCategory === 'agent'} onClick={() => setToolFailureCategory('agent')}>Agent ({agentToolFailures.length})</Button>
              <Button active={toolFailureCategory === 'direct'} onClick={() => setToolFailureCategory('direct')}>Direct ({directToolFailures.length})</Button>
            </Button.Group>
          </Inline>
          {selectedToolFailures.length === 0 ? (
            <Message state="neutral" noIcon>No {toolFailureCategory} tool call failures recorded.</Message>
          ) : (
            <BreakdownBars items={selectedToolFailures.map((t) => ({ label: t.tool, count: t.count }))} onSelect={(tool) => openToolFailureModal(tool, toolFailureCategory)} />
          )}
        </>
      )}
      {tab === 'security' && (
        securityJudge.byKind.length === 0 ? (
          <Message state="neutral" noIcon>No blocks recorded.</Message>
        ) : (
          <BreakdownBars items={securityJudge.byKind.map((k) => ({ label: k.kind, count: k.count }))} onSelect={openSecurityJudgeModal} />
        )
      )}
    </div>
  )
}

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [errorModal, setErrorModal] = useState<AsyncModalState<ErrorExample> | null>(null)
  const [toolFailureModal, setToolFailureModal] = useState<AsyncModalState<ToolFailureExample> | null>(null)
  const [toolFailureCategory, setToolFailureCategory] = useState<'agent' | 'direct'>('agent')
  const [securityJudgeModal, setSecurityJudgeModal] = useState<AsyncModalState<SecurityJudgeExample> | null>(null)
  const [usageErrorsModal, setUsageErrorsModal] = useState<AsyncModalState<UsageErrorExample> | null>(null)
  const [dayLogModal, setDayLogModal] = useState<AsyncModalState<DayLogEntry> | null>(null)
  const [noAnswerModal, setNoAnswerModal] = useState<AsyncModalState<NoAnswerExample> | null>(null)
  const [usageFilter, setUsageFilter] = useState<string>('all')
  const [usageErrorsOnly, setUsageErrorsOnly] = useState(false)
  const [usageSearch, setUsageSearch] = useState('')
  const [usagePage, setUsagePage] = useState(1)
  const [usageRunsByKey, setUsageRunsByKey] = useState<Record<string, UsageRunsState>>({})
  const loadedUsageKeys = useRef(new Set<string>())
  const [ticketInfoByKey, setTicketInfoByKey] = useState<Record<string, TicketInfoState>>({})
  const loadedTicketInfoKeys = useRef(new Set<string>())
  const [environment, setEnvironment] = useState<Environment>(DEFAULT_ENVIRONMENT)
  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULT_TIME_RANGE)

  const openErrorModal = useCallback(
    (kind: string) => {
      setErrorModal({ title: kind, items: null, loading: true, error: null })
      fetchErrorExamples(kind, environment, timeRange)
        .then((items) => setErrorModal({ title: kind, items, loading: false, error: null }))
        .catch((e: Error) => setErrorModal({ title: kind, items: null, loading: false, error: e.message }))
    },
    [environment, timeRange],
  )

  const openToolFailureModal = useCallback(
    (tool: string, category: 'agent' | 'direct') => {
      setToolFailureModal({ title: tool, items: null, loading: true, error: null })
      fetchToolFailureExamples(tool, category, environment, timeRange)
        .then((items) => setToolFailureModal({ title: tool, items, loading: false, error: null }))
        .catch((e: Error) => setToolFailureModal({ title: tool, items: null, loading: false, error: e.message }))
    },
    [environment, timeRange],
  )

  const openSecurityJudgeModal = useCallback(
    (kind: string) => {
      setSecurityJudgeModal({ title: kind, items: null, loading: true, error: null })
      fetchSecurityJudgeExamples(kind, environment, timeRange)
        .then((items) => setSecurityJudgeModal({ title: kind, items, loading: false, error: null }))
        .catch((e: Error) => setSecurityJudgeModal({ title: kind, items: null, loading: false, error: e.message }))
    },
    [environment, timeRange],
  )

  const openUsageErrorsModal = useCallback(
    (entityType: string, entityId: string | null) => {
      const title = entityId ? `#${entityId}` : entityType
      setUsageErrorsModal({ title, items: null, loading: true, error: null })
      fetchUsageErrors(entityType, entityId, environment, timeRange)
        .then((items) => setUsageErrorsModal({ title, items, loading: false, error: null }))
        .catch((e: Error) => setUsageErrorsModal({ title, items: null, loading: false, error: e.message }))
    },
    [environment, timeRange],
  )

  const loadUsageRuns = useCallback(
    (entityType: string, entityId: string | null) => {
      const key = `${entityType}-${entityId ?? 'none'}`
      if (loadedUsageKeys.current.has(key)) return
      loadedUsageKeys.current.add(key)
      setUsageRunsByKey((prev) => ({ ...prev, [key]: { items: null, loading: true, error: null } }))
      fetchUsageRuns(entityType, entityId, environment, timeRange)
        .then((items) => setUsageRunsByKey((prev) => ({ ...prev, [key]: { items, loading: false, error: null } })))
        .catch((e: Error) =>
          setUsageRunsByKey((prev) => ({ ...prev, [key]: { items: null, loading: false, error: e.message } })),
        )
    },
    [environment, timeRange],
  )

  const loadTicketInfo = useCallback((entityType: string, entityId: string | null) => {
    if (entityType !== 'ticket' || !entityId) return
    if (loadedTicketInfoKeys.current.has(entityId)) return
    loadedTicketInfoKeys.current.add(entityId)
    setTicketInfoByKey((prev) => ({ ...prev, [entityId]: { item: null, loading: true, error: null } }))
    fetchTicketInfo(entityId)
      .then((item) => setTicketInfoByKey((prev) => ({ ...prev, [entityId]: { item, loading: false, error: null } })))
      .catch((e: Error) =>
        setTicketInfoByKey((prev) => ({ ...prev, [entityId]: { item: null, loading: false, error: e.message } })),
      )
  }, [])

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

  const openNoAnswerModal = useCallback(() => {
    setNoAnswerModal({ title: 'Failed responses', items: null, loading: true, error: null })
    fetchNoAnswerExamples(environment, timeRange)
      .then((items) => setNoAnswerModal({ title: 'Failed responses', items, loading: false, error: null }))
      .catch((e: Error) => setNoAnswerModal({ title: 'Failed responses', items: null, loading: false, error: e.message }))
  }, [environment, timeRange])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    loadedUsageKeys.current.clear()
    setUsageRunsByKey({})
    loadedTicketInfoKeys.current.clear()
    setTicketInfoByKey({})
    fetchDashboard(environment, timeRange)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [environment, timeRange])

  useEffect(() => {
    load()
  }, [load])

  const dailyUsersData = (data?.dailyUsers ?? []).map((point) => ({
    ...point,
    label: dayFormatter.format(new Date(point.day)),
  }))

  const agentToolFailures = (data?.toolFailures ?? []).filter((t) => t.category === 'agent')
  const directToolFailures = (data?.toolFailures ?? []).filter((t) => t.category === 'direct')
  const selectedToolFailures = toolFailureCategory === 'direct' ? directToolFailures : agentToolFailures
  const costData = [...(data?.models ?? [])].sort((a, b) => b.calls - a.calls)
  const toolData = data?.tools ?? []
  const contextData = (data?.context ?? []).map((c) => ({
    ...c,
    label: c.type === 'none' ? 'No context' : c.type.charAt(0).toUpperCase() + c.type.slice(1),
  }))
  const dailyCostData = (data?.dailyCost ?? []).map((point) => ({
    ...point,
    label: dayFormatter.format(new Date(point.day)),
  }))

  const dailyUsageByContextTypes = [...new Set((data?.dailyUsageByContext ?? []).map((d) => d.type))]
  const dailyUsageByContextData = (() => {
    const byDay = new Map<string, Record<string, number | string>>()
    for (const row of data?.dailyUsageByContext ?? []) {
      const existing = byDay.get(row.day) ?? { label: dayFormatter.format(new Date(row.day)) }
      existing[row.type] = row.count
      byDay.set(row.day, existing)
    }
    return [...byDay.values()].sort((a, b) => {
      const aLabel = String(a.label)
      const bLabel = String(b.label)
      return aLabel.localeCompare(bLabel)
    })
  })()

  const USAGE_PAGE_SIZE = 10
  const usageTypes = [...new Set((data?.usage ?? []).map((u) => u.entityType))]
  const usageSearchLower = usageSearch.trim().toLowerCase()
  const usageWithErrors = (data?.usage ?? []).filter((u) => u.errorCount > 0).length
  const filteredUsage = (data?.usage ?? []).filter(
    (u) =>
      (usageFilter === 'all' || u.entityType === usageFilter) &&
      (!usageErrorsOnly || u.errorCount > 0) &&
      (usageSearchLower === '' ||
        (u.entityId ?? '').toLowerCase().includes(usageSearchLower) ||
        (u.model ?? '').toLowerCase().includes(usageSearchLower)),
  )
  const usageTotalPages = Math.max(1, Math.ceil(filteredUsage.length / USAGE_PAGE_SIZE))
  const pagedUsage = filteredUsage.slice((usagePage - 1) * USAGE_PAGE_SIZE, usagePage * USAGE_PAGE_SIZE)

  return (
    <ErrorBoundary label="the dashboard">
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
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
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
          <Grid cols={1} small={2} large={5} gap={16}>
            <Tile
              label="Response time"
              icon={faStopwatch}
              value={formatDuration(data.totals.avgResponseTimeSec)}
            />
            <Tile
              label="Cost & tokens"
              icon={faCoins}
              value={preciseCostFormatter.format(data.totals.costUsd)}
              sub={compactFormatter.format(data.totals.tokensUsed) + ' tokens'}
            />
            <Tile
              label="Conversations"
              icon={faComments}
              value={compactFormatter.format(data.totals.uniqueUsers)}
              sub={`users · ${compactFormatter.format(data.totals.uses)} chats`}
            />
            <Tile
              label="Solution agent"
              icon={faFlagCheckered}
              value={formatDuration(data.totals.solutionMedianResponseTimeSec)}
            />
            <Tile
              label="Failed responses"
              icon={faTriangleExclamation}
              value={`${data.totals.noAnswerPercent.toFixed(1)}%`}
              alert={data.totals.noAnswerPercent > 0}
              onClick={() => openNoAnswerModal()}
            />
          </Grid>

          <SectionBox title="Daily activity">
            <DailyActivityTabs
              dailyCostData={dailyCostData}
              dailyUsersData={dailyUsersData}
              dailyUsageByContextData={dailyUsageByContextData}
              dailyUsageByContextTypes={dailyUsageByContextTypes}
              openDayLogModal={openDayLogModal}
            />
          </SectionBox>

          <Grid cols={1} large={2} gap={24}>
            <SectionBox title="Models & tools">
              <ModelToolTabs modelData={costData} tools={data.tools} llmCalls={data.llmCalls} />
            </SectionBox>

            <SectionBox title="Usage by context & tools">
              <ContextToolsTabs contextData={contextData} toolData={toolData} />
            </SectionBox>
          </Grid>

          <SectionBox title="Issues">
            <IssuesTabs
              errors={data.errors}
              toolFailures={data.toolFailures}
              securityJudge={data.securityJudge}
              toolFailureCategory={toolFailureCategory}
              setToolFailureCategory={setToolFailureCategory}
              agentToolFailures={agentToolFailures}
              directToolFailures={directToolFailures}
              selectedToolFailures={selectedToolFailures}
              openErrorModal={openErrorModal}
              openToolFailureModal={openToolFailureModal}
              openSecurityJudgeModal={openSecurityJudgeModal}
            />
          </SectionBox>

          <SectionBox title="Conversation log">
            <Inline align="center" gap={8} style={{ marginBottom: 16, flexWrap: 'wrap' }}>
              <Button.Group>
                <Button
                  active={usageFilter === 'all'}
                  onClick={() => {
                    setUsageFilter('all')
                    setUsagePage(1)
                  }}
                >
                  All ({data.usage.length})
                </Button>
                {usageTypes.map((type) => (
                  <Button
                    key={type}
                    active={usageFilter === type}
                    onClick={() => {
                      setUsageFilter(type)
                      setUsagePage(1)
                    }}
                  >
                    {type === 'none' ? 'No context' : type.charAt(0).toUpperCase() + type.slice(1)} (
                    {data.usage.filter((u) => u.entityType === type).length})
                  </Button>
                ))}
              </Button.Group>
              <Button
                variant={usageErrorsOnly ? 'filled' : 'basic'}
                onClick={() => {
                  setUsageErrorsOnly((v) => !v)
                  setUsagePage(1)
                }}
              >
                <Icon icon={faTriangleExclamation} marginRight />
                Errors only ({usageWithErrors})
              </Button>
              <Input
                label="Search conversation log"
                hideLabel
                small
                clearable
                icon={faMagnifyingGlass}
                placeholder="Search by reference or model…"
                value={usageSearch}
                onChange={(e) => {
                  setUsageSearch(e.target.value)
                  setUsagePage(1)
                }}
                style={{ minWidth: 240 }}
              />
            </Inline>
            {filteredUsage.length === 0 ? (
              <Message state="neutral" noIcon>
                No conversations recorded for this filter yet.
              </Message>
            ) : (
              <Grid gap={16}>
                <Table key={`${usageFilter}-${usageErrorsOnly}-${usageSearchLower}-${usagePage}`}>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell></Table.HeaderCell>
                    <Table.HeaderCell>Last seen</Table.HeaderCell>
                    <Table.HeaderCell>Context</Table.HeaderCell>
                    <Table.HeaderCell>Reference</Table.HeaderCell>
                    <Table.HeaderCell>Model</Table.HeaderCell>
                    <Table.HeaderCell>Reasoning</Table.HeaderCell>
                    <Table.HeaderCell>Chats</Table.HeaderCell>
                    <Table.HeaderCell>Solution runs</Table.HeaderCell>
                    <Table.HeaderCell>Avg duration</Table.HeaderCell>
                    <Table.HeaderCell>Cost</Table.HeaderCell>
                    <Table.HeaderCell>Response</Table.HeaderCell>
                    <Table.HeaderCell>Errors</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {pagedUsage.map((row) => {
                    const link = entityLink(row.entityType, row.entityId)
                    const usageKey = `${row.entityType}-${row.entityId ?? 'none'}`
                    return (
                      <Table.Row
                        key={usageKey}
                        content={
                          <ErrorBoundary label="this row's details">
                            <UsageRowDetails
                              solutionRuns={row.runs}
                              chatRuns={usageRunsByKey[usageKey]}
                              ticketInfo={row.entityType === 'ticket' && row.entityId ? ticketInfoByKey[row.entityId] : undefined}
                            />
                          </ErrorBoundary>
                        }
                        onOpenChange={() => {
                          loadUsageRuns(row.entityType, row.entityId)
                          loadTicketInfo(row.entityType, row.entityId)
                        }}
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
                        <Table.Cell>{row.model ?? '—'}</Table.Cell>
                        <Table.Cell>
                          {row.reasoningEffort ? (
                            <Badge state="neutral">{row.reasoningEffort}</Badge>
                          ) : (
                            '—'
                          )}
                        </Table.Cell>
                        <Table.Cell>{row.uses}</Table.Cell>
                        <Table.Cell>{row.triggers || '—'}</Table.Cell>
                        <Table.Cell>{row.triggers > 0 ? formatDuration(row.avgDurationSec) : '—'}</Table.Cell>
                        <Table.Cell>
                          {row.costUsd != null ? preciseCostFormatter.format(row.costUsd) : '—'}
                        </Table.Cell>
                        <Table.Cell>
                          {row.noAnswerCount > 0 ? (
                            <Badge state="alert">No</Badge>
                          ) : (
                            <Badge state="success">Yes</Badge>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {row.errorCount > 0 ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                openUsageErrorsModal(row.entityType, row.entityId)
                              }}
                              style={{ all: 'unset', cursor: 'pointer' }}
                            >
                              <Badge state="alert">{row.errorCount} failed</Badge>
                            </button>
                          ) : (
                            <Badge state="neutral">OK</Badge>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    )
                  })}
                </Table.Body>
              </Table>
              {usageTotalPages > 1 && (
                <Inline align="center" style={{ justifyContent: 'center' }}>
                  <Pagination totalPages={usageTotalPages} currentPage={usagePage} onChange={setUsagePage} />
                </Inline>
              )}
              </Grid>
            )}
          </SectionBox>
        </Grid>
      )}

      <Modal
        isOpen={errorModal != null}
        onRequestClose={() => setErrorModal(null)}
        header={errorModal?.title}
        width={800}
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
                <Table.HeaderCell>Model</Table.HeaderCell>
                <Table.HeaderCell>Ticket</Table.HeaderCell>
                <Table.HeaderCell>Message</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {errorModal.items.map((e, i) => {
                const link = entityLink('ticket', e.ticketId)
                return (
                  <Table.Row key={i}>
                    <Table.Cell>{timeFormatter.format(new Date(e.time))}</Table.Cell>
                    <Table.Cell>{e.model ?? '—'}</Table.Cell>
                    <Table.Cell>
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer">
                          #{e.ticketId}
                        </a>
                      ) : (
                        (e.ticketId ?? '—')
                      )}
                    </Table.Cell>
                    <Table.Cell style={{ wordBreak: 'break-word' }}>{e.message}</Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table>
        )}
      </Modal>

      <Modal
        isOpen={toolFailureModal != null}
        onRequestClose={() => setToolFailureModal(null)}
        header={toolFailureModal?.title}
        width={800}
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
                <Table.HeaderCell>Model</Table.HeaderCell>
                <Table.HeaderCell>Ticket</Table.HeaderCell>
                <Table.HeaderCell>Detail</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {toolFailureModal.items.map((t, i) => {
                const link = entityLink('ticket', t.ticketId)
                return (
                  <Table.Row key={i}>
                    <Table.Cell>{timeFormatter.format(new Date(t.time))}</Table.Cell>
                    <Table.Cell>
                      <Badge state={t.kind === 'timeout' ? 'warning' : 'alert'}>{t.kind}</Badge>
                    </Table.Cell>
                    <Table.Cell>{t.model ?? '—'}</Table.Cell>
                    <Table.Cell>
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer">
                          #{t.ticketId}
                        </a>
                      ) : (
                        (t.ticketId ?? '—')
                      )}
                    </Table.Cell>
                    <Table.Cell style={{ wordBreak: 'break-word' }}>{t.detail}</Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table>
        )}
      </Modal>

      <Modal
        isOpen={securityJudgeModal != null}
        onRequestClose={() => setSecurityJudgeModal(null)}
        header={securityJudgeModal?.title}
        width={700}
      >
        {securityJudgeModal?.loading && (
          <Inline align="center" gap={8}>
            <Icon.Spinner size={20} />
            <span>Loading examples …</span>
          </Inline>
        )}
        {securityJudgeModal?.error && (
          <Message state="alert" noIcon>
            {securityJudgeModal.error}
          </Message>
        )}
        {securityJudgeModal?.items && (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Time</Table.HeaderCell>
                <Table.HeaderCell>Ticket</Table.HeaderCell>
                <Table.HeaderCell>Detail</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {securityJudgeModal.items.map((s, i) => {
                const link = entityLink('ticket', s.ticketId)
                return (
                  <Table.Row key={i}>
                    <Table.Cell>{timeFormatter.format(new Date(s.time))}</Table.Cell>
                    <Table.Cell>
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer">
                          #{s.ticketId}
                        </a>
                      ) : (
                        (s.ticketId ?? '—')
                      )}
                    </Table.Cell>
                    <Table.Cell style={{ wordBreak: 'break-word' }}>{s.detail}</Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table>
        )}
      </Modal>

      <Modal
        isOpen={usageErrorsModal != null}
        onRequestClose={() => setUsageErrorsModal(null)}
        header={usageErrorsModal ? `Errors · ${usageErrorsModal.title}` : undefined}
        width={800}
      >
        {usageErrorsModal?.loading && (
          <Inline align="center" gap={8}>
            <Icon.Spinner size={20} />
            <span>Loading examples …</span>
          </Inline>
        )}
        {usageErrorsModal?.error && (
          <Message state="alert" noIcon>
            {usageErrorsModal.error}
          </Message>
        )}
        {usageErrorsModal?.items && (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Time</Table.HeaderCell>
                <Table.HeaderCell>Kind</Table.HeaderCell>
                <Table.HeaderCell>Message</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {usageErrorsModal.items.map((e, i) => (
                <Table.Row key={i}>
                  <Table.Cell>{timeFormatter.format(new Date(e.time))}</Table.Cell>
                  <Table.Cell>{e.kind}</Table.Cell>
                  <Table.Cell style={{ wordBreak: 'break-word' }}>{e.message}</Table.Cell>
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
                <Table.HeaderCell>Ticket</Table.HeaderCell>
                <Table.HeaderCell>Model</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {dayLogModal.items.map((entry, i) => {
                const link = entityLink(entry.entityType, entry.entityId)
                return (
                  <Table.Row key={i}>
                    <Table.Cell>{timeFormatter.format(new Date(entry.time))}</Table.Cell>
                    <Table.Cell>{entry.userId}</Table.Cell>
                    <Table.Cell>{entry.entityType}</Table.Cell>
                    <Table.Cell style={{ wordBreak: 'break-word' }}>
                      {entry.entityType === 'ticket' && entry.entityId ? (
                        <>
                          {link ? (
                            <a href={link} target="_blank" rel="noreferrer">#{entry.entityId}</a>
                          ) : (
                            `#${entry.entityId}`
                          )}
                          {entry.ticketTitle ? ` · ${entry.ticketTitle}` : ''}
                        </>
                      ) : (
                        '—'
                      )}
                    </Table.Cell>
                    <Table.Cell>{entry.model}</Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table>
        )}
      </Modal>

      <Modal
        isOpen={noAnswerModal != null}
        onRequestClose={() => setNoAnswerModal(null)}
        header={noAnswerModal?.title}
        width={800}
      >
        {noAnswerModal?.loading && (
          <Inline align="center" gap={8}>
            <Icon.Spinner size={20} />
            <span>Loading examples …</span>
          </Inline>
        )}
        {noAnswerModal?.error && (
          <Message state="alert" noIcon>
            {noAnswerModal.error}
          </Message>
        )}
        {noAnswerModal?.items && (
          <>
            {noAnswerModal.items.length === 0 ? (
              <Message state="neutral" noIcon>
                No failed responses in this time range.
              </Message>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Time</Table.HeaderCell>
                    <Table.HeaderCell>Reason</Table.HeaderCell>
                    <Table.HeaderCell>Model</Table.HeaderCell>
                    <Table.HeaderCell>Ticket</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {noAnswerModal.items.map((e, i) => {
                    const link = entityLink('ticket', e.ticketId)
                    return (
                      <Table.Row key={i}>
                        <Table.Cell>{timeFormatter.format(new Date(e.time))}</Table.Cell>
                        <Table.Cell style={{ wordBreak: 'break-word' }}>{e.reason}</Table.Cell>
                        <Table.Cell>{e.model ?? '—'}</Table.Cell>
                        <Table.Cell>
                          {link ? (
                            <a href={link} target="_blank" rel="noreferrer">
                              #{e.ticketId}
                            </a>
                          ) : (
                            (e.ticketId ?? '—')
                          )}
                        </Table.Cell>
                      </Table.Row>
                    )
                  })}
                </Table.Body>
              </Table>
            )}
          </>
        )}
      </Modal>
    </div>
    </ErrorBoundary>
  )
}

export default Dashboard
