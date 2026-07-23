import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Sirve la página de prueba. Devuelve la URL base. */
export function startFixtureServer(port = 0) {
  const html = readFileSync(join(here, 'index.html'))
  // `/salir` es otra pantalla: reproduce el «cerrar sesión» que navega al
  // instante y se lleva por delante el elemento que el paso debe señalar.
  const salir = Buffer.from(
    '<!doctype html><meta charset="utf-8"><title>Sesión cerrada</title>' +
      '<body style="font:16px system-ui;padding:40px"><h1>Sesión cerrada</h1>' +
      '<p>Vuelve a iniciar sesión para continuar.</p></body>'
  )
  const server = createServer((req, res) => {
    const salida = (req.url ?? '').startsWith('/salir')
    const responder = () => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(salida ? salir : html)
    }
    // Un cierre de sesión real habla con el servidor antes de cambiar de
    // pantalla. Mientras responde, la página anterior sigue a la vista: ese es
    // el margen en el que el grabador debe capturar el elemento pulsado.
    if (salida) setTimeout(responder, 150)
    else responder()
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address()
      resolve({ url: `http://127.0.0.1:${actual}/`, close: () => server.close() })
    })
  })
}
