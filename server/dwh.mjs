import sql from "mssql"

let pool = null
let connecting = null

// The DWH is reached through a Minato link sidecar listening on localhost. The app scales to
// zero, and on a cold start this process is usually serving before that sidecar accepts
// connections - the first connect then fails outright with "Could not connect". Retrying with
// backoff turns that startup race into a slightly slower first query instead of a failed page.
const CONNECT_ATTEMPTS = 6
const CONNECT_RETRY_BASE_MS = 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A pool that has silently died (idle timeout, sidecar restart) doesn't always emit
 * `error` before the next query hits it, so `.connected` is checked on every call rather
 * than trusting a cached reference forever. `connecting` dedupes concurrent (re)connects
 * so two requests racing on a cold pool don't open two separate connections. */
async function getPool() {
  if (pool && pool.connected) return pool
  if (connecting) return connecting

  connecting = (async () => {
    const addr = process.env.MINATO_LINK_DWH_ADDR
    if (!addr) {
      const err = new Error("MINATO_LINK_DWH_ADDR is not set")
      err.status = 500
      throw err
    }

    const lastColon = addr.lastIndexOf(":")
    const host = addr.slice(0, lastColon)
    const port = parseInt(addr.slice(lastColon + 1), 10)

    const config = {
      server: host,
      port,
      user: process.env.DWH_USER ?? "",
      password: process.env.DWH_PASSWORD ?? "",
      database: "dwh",
      options: { encrypt: false, trustServerCertificate: true },
      // The solution-agent cluster rollup runs a CTE with a window function over a large
      // literal exclusion list against a 5-year ticket table - the default 15s is routinely
      // too tight for that one, even though every other query here finishes in well under a
      // second. There's no per-query override in this driver, so this is the floor for all of
      // them.
      requestTimeout: 60000,
      // The solution-agent rollup runs its batches a few at a time (DWH_BATCH_CONCURRENCY), and
      // two of those loops can be in flight at once - so the pool has to hold more connections
      // than that, or a batch sits waiting on the pool instead of on the server.
      pool: { max: 8, min: 0, idleTimeoutMillis: 30000 },
    }

    for (let attempt = 1; ; attempt++) {
      // A pool whose connect() rejected can't be reused, so each attempt gets a fresh one.
      const newPool = new sql.ConnectionPool(config)
      newPool.on("error", () => {
        if (pool === newPool) pool = null
      })
      try {
        await newPool.connect()
        pool = newPool
        return pool
      } catch (err) {
        await Promise.resolve(newPool.close()).catch(() => {})
        if (attempt >= CONNECT_ATTEMPTS) throw err
        console.warn(`[dwh] connect attempt ${attempt} failed (${err.message}), retrying`)
        await sleep(CONNECT_RETRY_BASE_MS * 2 ** (attempt - 1))
      }
    }
  })()

  try {
    return await connecting
  } finally {
    connecting = null
  }
}

export async function dwhQuery(sqlText, inputs = []) {
  const p = await getPool()
  try {
    const req = new sql.Request(p)
    for (const { name, type, value } of inputs) {
      req.input(name, type, value)
    }
    const result = await req.query(sqlText)
    return result.recordset
  } catch (err) {
    // A query failure often means the pool is dead even when no `error` event fired.
    // Drop the cached reference so the next call reconnects instead of failing forever.
    if (pool === p) pool = null
    throw err
  }
}

export const sqlTypes = sql
