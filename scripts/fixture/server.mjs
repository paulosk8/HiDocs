import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Sirve la página de prueba. Devuelve la URL base. */
export function startFixtureServer(port = 0) {
  const html = readFileSync(join(here, 'index.html'))
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address()
      resolve({ url: `http://127.0.0.1:${actual}/`, close: () => server.close() })
    })
  })
}
