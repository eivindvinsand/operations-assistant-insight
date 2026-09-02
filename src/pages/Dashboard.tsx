import { useCallback, useEffect, useState } from 'react'
import { marked } from 'marked'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  faArrowsRotate,
  faBolt,
  faBrain,
  faCircleInfo,
  faComments,
  faFlagCheckered,
  faTicket,
  faTriangleExclamation,
  faWandMagicSparkles,
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
import {
  fetchDashboard,
  type DashboardData,
  type DashboardLevel,
  type RunStep,
  type StepType,
  type TicketRun,
} from '../lib/dashboard'

const TICKET_URL_BASE = 'https://internal-operations-staging.apps.aa.intility.com/tickets'

const levelBadgeState: Record<DashboardLevel, 'neutral' | 'warning' | 'alert'> = {
  debug: 'neutral',
  info: 'neutral',
  warning: 'warning',
  error: 'alert',
}

const hourFormatter = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
})

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

const tooltipContentStyle = {
  background: 'var(--bfc-base-3)',
  border: '1px solid var(--bfc-base-c-dimmed)',
  borderRadius: 8,
  color: 'var(--bfc-base-c)',
}
const tooltipItemStyle = { color: 'var(--bfc-base-c)' }
const tooltipLabelStyle = { color: 'var(--bfc-base-c-2)' }

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

function StatTile({
  icon,
  label,
  value,
}: {
  icon: Parameters<typeof Icon>[0]['icon']
  label: string
  value: string
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
          <h5 className="bf-h5">{value}</h5>
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

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchDashboard()
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const chartData = (data?.timeline ?? []).map((point) => ({
    ...point,
    label: hourFormatter.format(new Date(point.hour)),
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

  return (
    <div className="bf-page-padding">
      <Inline align="center" style={{ marginBottom: 24 }}>
        <Inline.Stretch>
          <h1>Dashboard</h1>
          <p className="bfc-base-2">Live insight from Logfire</p>
        </Inline.Stretch>
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
            <StatTile icon={faBolt} label="Events (24h)" value={compactFormatter.format(data.totals.events)} />
            <StatTile icon={faTriangleExclamation} label="Errors (24h)" value={compactFormatter.format(data.totals.errors)} />
            <StatTile
              icon={faWandMagicSparkles}
              label="Solution agent runs (7d)"
              value={compactFormatter.format(data.totals.solutionAgentRuns)}
            />
            <StatTile
              icon={faTicket}
              label="Unique tickets triggered (7d)"
              value={compactFormatter.format(data.totals.solutionAgentTickets)}
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

          <SectionBox title="Events per hour (24h)">
            {chartData.length === 0 ? (
              <Message state="neutral" noIcon>
                No events recorded in Logfire yet.
              </Message>
            ) : (
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData} margin={{ left: -20 }}>
                  <XAxis
                    axisLine={false}
                    tickLine={false}
                    dataKey="label"
                    tick={{ fill: 'var(--bfc-base-c-2)', fontSize: 11 }}
                    dy={4}
                  />
                  <YAxis hide allowDecimals={false} />
                  <Tooltip cursor={false} contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
                  <Bar dataKey="count" name="Events" fill="var(--bfc-chill)" radius={3} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </SectionBox>

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

          <SectionBox title="Tickets solution agent worked on (7d)">
            {data.tickets.length === 0 ? (
              <Message state="neutral" noIcon>
                Solution agent has not been triggered yet.
              </Message>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell></Table.HeaderCell>
                    <Table.HeaderCell>Ticket</Table.HeaderCell>
                    <Table.HeaderCell>Times triggered</Table.HeaderCell>
                    <Table.HeaderCell>Avg duration</Table.HeaderCell>
                    <Table.HeaderCell>Cost</Table.HeaderCell>
                    <Table.HeaderCell>Outcome</Table.HeaderCell>
                    <Table.HeaderCell>Last seen</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.tickets.map((row) => (
                    <Table.Row key={row.ticket} content={<TicketRunDetails runs={row.runs} />}>
                      <Table.Cell>
                        <a href={`${TICKET_URL_BASE}/${row.ticket}`} target="_blank" rel="noreferrer">
                          #{row.ticket}
                        </a>
                      </Table.Cell>
                      <Table.Cell>{row.triggers}</Table.Cell>
                      <Table.Cell>{formatDuration(row.avgDurationSec)}</Table.Cell>
                      <Table.Cell>
                        {row.costUsd > 0 ? preciseCostFormatter.format(row.costUsd) : '—'}
                      </Table.Cell>
                      <Table.Cell>
                        {row.exceptions > 0 ? (
                          <Badge state="alert">{row.exceptions} failed</Badge>
                        ) : (
                          <Badge state="neutral">OK</Badge>
                        )}
                      </Table.Cell>
                      <Table.Cell>{timeFormatter.format(new Date(row.lastSeen))}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </SectionBox>

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
    </div>
  )
}

export default Dashboard
