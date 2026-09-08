import sql from "mssql"

let pool = null

async function getPool() {
  if (pool) return pool

  const addr = process.env.MINATO_LINK_DWH_ADDR
  if (!addr) {
    const err = new Error("MINATO_LINK_DWH_ADDR is not set")
    err.status = 500
    throw err
  }

  const lastColon = addr.lastIndexOf(":")
  const host = addr.slice(0, lastColon)
  const port = parseInt(addr.slice(lastColon + 1), 10)

  pool = new sql.ConnectionPool({
    server: host,
    port,
    user: process.env.DWH_USER ?? "",
    password: process.env.DWH_PASSWORD ?? "",
    database: "dwh",
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 15000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  })

  pool.on("error", () => {
    pool = null
  })

  await pool.connect()
  return pool
}

export async function dwhQuery(sqlText, inputs = []) {
  const p = await getPool()
  const req = new sql.Request(p)
  for (const { name, type, value } of inputs) {
    req.input(name, type, value)
  }
  const result = await req.query(sqlText)
  return result.recordset
}

export const sqlTypes = sql
