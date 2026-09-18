const ENDPOINTS = [
  "https://logfire.intility.app/v2/query",
  "https://logfire-us.pydantic.dev/v2/query",
  "https://logfire-eu.pydantic.dev/v2/query",
]

let workingEndpoint = null

// The solution-agent rollup fans out into dozens of these at once, and a single one hanging used
// to hang the whole build behind it - fetch has no timeout of its own.
const QUERY_TIMEOUT_MS = 60 * 1000
const QUERY_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 750
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

/** Blips worth another attempt against the same endpoint: rate limiting, a server-side error, a
 * timeout, or a dropped connection (fetch rejects with a TypeError for those). A 4xx other than
 * 429 is a real answer - retrying it just wastes time. */
function isTransient(err) {
  return err.retryable === true || err.name === "TimeoutError" || err.name === "AbortError" || err instanceof TypeError
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function queryOnce(endpoint, sql, minTimestamp, maxTimestamp) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LOGFIRE_API_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sql,
      min_timestamp: minTimestamp,
      max_timestamp: maxTimestamp,
      limit: 1000,
    }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const err = new Error(`Logfire query failed (${res.status}): ${body}`)
    err.status = res.status
    err.retryable = RETRYABLE_STATUSES.has(res.status)
    throw err
  }

  return res.json()
}

/** queryOnce with a bounded retry on transient failures, so one blip in a fan-out of dozens of
 * queries doesn't fail the whole rollup. */
async function queryWithRetry(endpoint, sql, minTimestamp, maxTimestamp) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await queryOnce(endpoint, sql, minTimestamp, maxTimestamp)
    } catch (err) {
      if (attempt >= QUERY_ATTEMPTS || !isTransient(err)) throw err
      await sleep(RETRY_BASE_DELAY_MS * attempt)
    }
  }
}

/** Runs a Logfire SQL query, remembering which regional endpoint answers this token. */
export async function logfireQuery(
  sql,
  { hoursBack = 24, minTimestamp: minTimestampOverride, maxTimestamp: maxTimestampOverride } = {},
) {
  if (!process.env.LOGFIRE_API_KEY) {
    const err = new Error("LOGFIRE_API_KEY is not set")
    err.status = 500
    throw err
  }

  const maxTimestamp = maxTimestampOverride ?? new Date().toISOString()
  const minTimestamp = minTimestampOverride ?? new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()

  const endpoints = workingEndpoint
    ? [workingEndpoint, ...ENDPOINTS.filter((e) => e !== workingEndpoint)]
    : ENDPOINTS

  let lastError
  for (const endpoint of endpoints) {
    try {
      const result = await queryWithRetry(endpoint, sql, minTimestamp, maxTimestamp)
      workingEndpoint = endpoint
      return result
    } catch (e) {
      lastError = e
      if (e.status !== 401) throw e
    }
  }
  throw lastError
}
