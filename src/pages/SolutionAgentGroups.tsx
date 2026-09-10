import { useCallback, useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  faArrowsRotate,
  faBuilding,
  faClock,
  faCubes,
  faLayerGroup,
  faLink,
  faSitemap,
  faTicket,
} from '@fortawesome/free-solid-svg-icons'
import Grid from '@intility/bifrost-react/Grid'
import Inline from '@intility/bifrost-react/Inline'
import Icon from '@intility/bifrost-react/Icon'
import Button from '@intility/bifrost-react/Button'
import Badge from '@intility/bifrost-react/Badge'
import Message from '@intility/bifrost-react/Message'
import Modal from '@intility/bifrost-react/Modal'
import Table from '@intility/bifrost-react/Table'
import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  fetchSolutionAgentGroups,
  fetchSolutionGroupConfidence,
  fetchSolutionGroupDetail,
  type ConfidenceLevel,
  type Environment,
  type GroupConfidence,
  type SolutionAgentGroups,
  type SolutionGroupDetail,
  type SolutionGroupDimension,
  type SolutionGroupSummary,
} from '../lib/dashboard'
import {
  BreakdownBars,
  SectionBox,
  Tile,
  compactFormatter,
  formatDuration,
  pivotDaily,
  tooltipContentStyle,
  tooltipItemStyle,
  tooltipLabelStyle,
} from '../lib/ui'

const DIMENSION_TABS: { key: SolutionGroupDimension; label: string; icon: typeof faLayerGroup }[] = [
  { key: 'category', label: 'Category', icon: faLayerGroup },
  { key: 'product', label: 'Product', icon: faCubes },
  { key: 'company', label: 'Company', icon: faBuilding },
  { key: 'cluster', label: 'Ticket clusters', icon: faSitemap },
]

function formatDays(days: number | null | undefined): string {
  if (days == null) return '–'
  return `${days.toFixed(1)} d`
}

function formatPercent(percent: number | null | undefined): string {
  if (percent == null) return '–'
  return `${percent.toFixed(0)}%`
}

function GroupsTable({
  items,
  dimension,
  confidence,
  confidenceLoading,
  onSelect,
}: {
  items: SolutionGroupSummary[]
  dimension: SolutionGroupDimension
  confidence: Record<string, GroupConfidence>
  confidenceLoading: boolean
  onSelect: (item: SolutionGroupSummary) => void
}) {
  const isCluster = dimension === 'cluster'
  const rightAlign = { textAlign: 'right' } as const
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table style={{ width: '100%' }}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Navn</Table.HeaderCell>
            {isCluster && <Table.HeaderCell>Hierarki</Table.HeaderCell>}
            <Table.HeaderCell style={rightAlign}>{isCluster ? 'AI-saker' : 'Saker'}</Table.HeaderCell>
            {isCluster && <Table.HeaderCell style={rightAlign}>Andre saker i klynge</Table.HeaderCell>}
            {isCluster && <Table.HeaderCell style={rightAlign}>Totalt i klynge</Table.HeaderCell>}
            <Table.HeaderCell style={rightAlign}>Kjøringer</Table.HeaderCell>
            <Table.HeaderCell style={rightAlign}>Snitt varighet</Table.HeaderCell>
            <Table.HeaderCell style={rightAlign}>Høy konfidens</Table.HeaderCell>
            <Table.HeaderCell style={rightAlign}>Medium konfidens</Table.HeaderCell>
            <Table.HeaderCell style={rightAlign}>Median løsningstid (AI)</Table.HeaderCell>
            {isCluster && <Table.HeaderCell style={rightAlign}>Median løsningstid (andre)</Table.HeaderCell>}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {items.map((item) => {
            const c = confidence[item.key]
            return (
              <Table.Row key={item.key} onClick={() => onSelect(item)}>
                <Table.Cell>{item.label}</Table.Cell>
                {isCluster && (
                  <Table.Cell>
                    <small className="bfc-base-2">{item.hierarchyName ?? '–'}</small>
                  </Table.Cell>
                )}
                <Table.Cell style={rightAlign}>{compactFormatter.format(item.ticketCount)}</Table.Cell>
                {isCluster && (
                  <Table.Cell style={rightAlign}>{compactFormatter.format(item.otherTicketCount ?? 0)}</Table.Cell>
                )}
                {isCluster && (
                  <Table.Cell style={rightAlign}>
                    {compactFormatter.format(item.totalTicketCount ?? item.ticketCount)}
                  </Table.Cell>
                )}
                <Table.Cell style={rightAlign}>{compactFormatter.format(item.runCount)}</Table.Cell>
                <Table.Cell style={rightAlign}>{formatDuration(item.avgDurationSec)}</Table.Cell>
                <Table.Cell style={rightAlign}>
                  {confidenceLoading && !c ? '…' : formatPercent(c?.highPercent)}
                </Table.Cell>
                <Table.Cell style={rightAlign}>
                  {confidenceLoading && !c ? '…' : formatPercent(c?.mediumPercent)}
                </Table.Cell>
                <Table.Cell style={rightAlign}>{formatDays(item.medianCloseDaysAi)}</Table.Cell>
                {isCluster && <Table.Cell style={rightAlign}>{formatDays(item.medianCloseDaysOther)}</Table.Cell>}
              </Table.Row>
            )
          })}
        </Table.Body>
      </Table>
    </div>
  )
}

const CONFIDENCE_META: Record<ConfidenceLevel, { label: string; color: string }> = {
  high: { label: 'Høy', color: 'var(--bfc-success)' },
  medium: { label: 'Medium', color: 'var(--bfc-warning)' },
  low: { label: 'Lav', color: 'var(--bfc-alert)' },
  unknown: { label: 'Ukjent', color: 'var(--bfc-base-c-dimmed)' },
}

function groupsForDimension(groups: SolutionAgentGroups, dimension: SolutionGroupDimension): SolutionGroupSummary[] {
  if (dimension === 'category') return groups.byCategory
  if (dimension === 'product') return groups.byProduct
  if (dimension === 'company') return groups.byCompany
  return groups.byCluster
}

interface DetailModalState {
  dimension: SolutionGroupDimension
  value: string
  label: string
  detail: SolutionGroupDetail | null
  loading: boolean
  error: string | null
}

function ConfidenceBars({ confidence }: { confidence: SolutionGroupDetail['confidence'] }) {
  const total = confidence.reduce((sum, c) => sum + c.count, 0)
  if (total === 0) return <Message state="neutral" noIcon>Ingen data.</Message>
  return (
    <Grid gap={8}>
      {confidence
        .filter((c) => c.count > 0)
        .map((c) => {
          const meta = CONFIDENCE_META[c.level]
          const percent = (c.count / total) * 100
          return (
            <Inline key={c.level} align="center" gap={12}>
              <Inline.Stretch>
                <small className="bfc-base-2" style={{ display: 'block', marginBottom: 2 }}>
                  {meta.label}
                </small>
                <div style={{ height: 6, background: 'var(--bfc-base-3)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${percent}%`, background: meta.color }} />
                </div>
              </Inline.Stretch>
              <small className="bfc-base-2">
                {c.count} ({percent.toFixed(0)}%)
              </small>
            </Inline>
          )
        })}
    </Grid>
  )
}

function GroupDetailModal({
  state,
  onClose,
}: {
  state: DetailModalState | null
  onClose: () => void
}) {
  const detail = state?.detail
  const dailyUsageData = detail ? pivotDaily(detail.dailyUsage, () => 'count') : []

  return (
    <Modal isOpen={state != null} onRequestClose={onClose} header={state?.label} width={900}>
      {state?.loading && (
        <Inline align="center" gap={8}>
          <Icon.Spinner size={20} />
          <span>Henter detaljer …</span>
        </Inline>
      )}
      {state?.error && (
        <Message state="alert" noIcon>
          {state.error}
        </Message>
      )}
      {detail && (
        <Grid gap={24}>
          <Grid cols={1} small={3} gap={16}>
            <Tile label="Saker" icon={faTicket} value={compactFormatter.format(detail.ticketCount)} />
            <Tile label="Kjøringer" icon={faArrowsRotate} value={compactFormatter.format(detail.runCount)} />
            <Tile label="Snitt varighet" icon={faClock} value={formatDuration(detail.avgDurationSec)} />
          </Grid>

          <Grid cols={1} large={2} gap={24}>
            <SectionBox title="Konfidens">
              <ConfidenceBars confidence={detail.confidence} />
              <small className="bfc-base-2" style={{ display: 'block', marginTop: 12 }}>
                Basert på de {detail.sampledRuns} nyeste kjøringene i gruppen.
              </small>
            </SectionBox>

            <SectionBox title="Mest brukte kilder">
              {detail.sources.length === 0 ? (
                <Message state="neutral" noIcon>Ingen kilder funnet.</Message>
              ) : (
                <Grid gap={8}>
                  {detail.sources.map((s) => (
                    <Inline key={s.url || s.title} align="center" gap={8}>
                      <Icon icon={faLink} className="bfc-base-2" />
                      <Inline.Stretch>
                        {s.url ? (
                          <a href={s.url} target="_blank" rel="noreferrer">
                            {s.title}
                          </a>
                        ) : (
                          <span>{s.title}</span>
                        )}
                      </Inline.Stretch>
                      <Badge state="neutral">{s.count}</Badge>
                    </Inline>
                  ))}
                </Grid>
              )}
            </SectionBox>
          </Grid>

          <SectionBox title="Bruk over tid">
            {dailyUsageData.length === 0 ? (
              <Message state="neutral" noIcon>Ingen kjøringer registrert.</Message>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={dailyUsageData} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="5 5" vertical={false} stroke="var(--bfc-base-c-dimmed)" />
                  <XAxis axisLine={false} tickLine={false} dataKey="label" tick={{ fill: 'var(--bfc-base-c-2)' }} dy={8} />
                  <YAxis axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: 'var(--bfc-base-c-2)' }} />
                  <Tooltip contentStyle={tooltipContentStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
                  <Line type="monotone" dataKey="count" name="Kjøringer" stroke="var(--bfc-brand)" strokeWidth={2} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </SectionBox>

          <SectionBox title="Mest brukte verktøy">
            {detail.tools.length === 0 ? (
              <Message state="neutral" noIcon>Ingen verktøykall registrert.</Message>
            ) : (
              <BreakdownBars items={detail.tools.map((t) => ({ label: t.tool, count: t.count }))} onSelect={() => {}} />
            )}
          </SectionBox>
        </Grid>
      )}
    </Modal>
  )
}

function SolutionAgentGroupsPage() {
  const [environment, setEnvironment] = useState<Environment>(DEFAULT_ENVIRONMENT)
  const [groups, setGroups] = useState<SolutionAgentGroups | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<SolutionGroupDimension>('category')
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null)
  const [confidenceByDimension, setConfidenceByDimension] = useState<
    Partial<Record<SolutionGroupDimension, Record<string, GroupConfidence>>>
  >({})
  const [confidenceLoadingDimension, setConfidenceLoadingDimension] = useState<SolutionGroupDimension | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    setConfidenceByDimension({})
    fetchSolutionAgentGroups(environment)
      .then((data) => setGroups(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [environment])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!groups || confidenceByDimension[tab]) return
    setConfidenceLoadingDimension(tab)
    fetchSolutionGroupConfidence(tab, environment)
      .then((data) => setConfidenceByDimension((prev) => ({ ...prev, [tab]: data })))
      .catch(() => {})
      .finally(() => setConfidenceLoadingDimension((current) => (current === tab ? null : current)))
  }, [groups, tab, environment, confidenceByDimension])

  const openDetail = useCallback(
    (dimension: SolutionGroupDimension, value: string, label: string) => {
      setDetailModal({ dimension, value, label, detail: null, loading: true, error: null })
      fetchSolutionGroupDetail(dimension, value, environment)
        .then((detail) => setDetailModal({ dimension, value, label, detail, loading: false, error: null }))
        .catch((e: Error) =>
          setDetailModal({ dimension, value, label, detail: null, loading: false, error: e.message }),
        )
    },
    [environment],
  )

  const activeItems = groups ? groupsForDimension(groups, tab) : []

  return (
    <div className="bf-page-padding">
      <Inline align="center" gap={12} style={{ marginBottom: 24, flexWrap: 'wrap' }}>
        <Inline.Stretch>
          <h1>Solution Agent</h1>
          <p className="bfc-base-2">
            Saker fordelt på kategori, produkt, selskap og ticket cluster — totalt for alle Logfire-kjøringer
          </p>
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
          Oppdater
        </Button>
      </Inline>

      {error && (
        <Message state="alert" header="Kunne ikke hente data" style={{ marginBottom: 24 }}>
          {error}
        </Message>
      )}

      {loading && !groups && (
        <Inline align="center" gap={8}>
          <Icon.Spinner size={24} />
          <span>Laster data …</span>
        </Inline>
      )}

      {groups && (
        <Grid gap={24}>
          <Grid cols={1} small={2} gap={16}>
            <Tile label="Saker med løsningsforslag" icon={faTicket} value={compactFormatter.format(groups.totals.tickets)} />
            <Tile label="Kjøringer totalt" icon={faArrowsRotate} value={compactFormatter.format(groups.totals.runs)} />
          </Grid>

          <SectionBox title="Bruk per gruppe">
            <Inline style={{ marginBottom: 16, justifyContent: 'flex-end' }}>
              <Button.Group>
                {DIMENSION_TABS.map((d) => (
                  <Button key={d.key} active={tab === d.key} onClick={() => setTab(d.key)}>
                    <Icon icon={d.icon} marginRight /> {d.label} ({groupsForDimension(groups, d.key).length})
                  </Button>
                ))}
              </Button.Group>
            </Inline>
            {activeItems.length === 0 ? (
              <Message state="neutral" noIcon>Ingen saker registrert.</Message>
            ) : (
              <GroupsTable
                items={activeItems}
                dimension={tab}
                confidence={confidenceByDimension[tab] ?? {}}
                confidenceLoading={confidenceLoadingDimension === tab}
                onSelect={(item) => openDetail(tab, item.key, item.label)}
              />
            )}
          </SectionBox>
        </Grid>
      )}

      <GroupDetailModal state={detailModal} onClose={() => setDetailModal(null)} />
    </div>
  )
}

export default SolutionAgentGroupsPage
