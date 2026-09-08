import sql from "mssql"

let pool = null
let connecting = null

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

    const newPool = new sql.ConnectionPool({
      server: host,
      port,
      user: process.env.DWH_USER ?? "",
      password: process.env.DWH_PASSWORD ?? "",
      database: "dwh",
      options: { encrypt: false, trustServerCertificate: true },
      requestTimeout: 15000,
      pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    })
    newPool.on("error", () => {
      if (pool === newPool) pool = null
    })

    await newPool.connect()
    pool = newPool
    return pool
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
