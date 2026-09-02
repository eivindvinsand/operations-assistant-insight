const ENDPOINTS = [
  "https://logfire.intility.app/v2/query",
  "https://logfire-us.pydantic.dev/v2/query",
  "https://logfire-eu.pydantic.dev/v2/query",
]

let workingEndpoint = null

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
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const err = new Error(`Logfire query failed (${res.status}): ${body}`)
    err.status = res.status
    throw err
  }

  return res.json()
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
      const result = await queryOnce(endpoint, sql, minTimestamp, maxTimestamp)
      workingEndpoint = endpoint
      return result
    } catch (e) {
      lastError = e
      if (e.status !== 401) throw e
    }
  }
  throw lastError
}
