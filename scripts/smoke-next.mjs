/**
 * Prueba contra un Next.js real (§11, etapa 7).
 *
 * La página de prueba local imita los patrones problemáticos, pero no sustituye
 * a una app con hidratación, App Router y portales de verdad. Este script abre
 * un sitio Next.js público, graba unas interacciones y muestra qué selectores
 * salen y si las capturas llegan completas.
 *
 *   npm run build && node scripts/smoke-next.mjs [url]
 */
import { spawn, execSync } from 'node:child_process'
import { statSync } from 'node:fs'
import electronPath from 'electron'
import { chromium } from 'playwright-core'

const PORT = 9333
const SITE = process.argv[2] ?? 'https://nextjs.org/'

// Una ejecución anterior interrumpida dejaría el puerto ocupado y la prueba
// se conectaría a esa instancia en vez de a la nueva.
try {
  execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' })
} catch {}

const child = spawn(electronPath, ['.'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))

let browser
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0]

  const gui = await (async () => {
    for (let i = 0; i < 60; i++) {
      const p = ctx.pages().find((p) => /index\.html|localhost:\d+/.test(p.url()))
      if (p && (await p.locator('.topbar').count())) return p
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('No apareció la GUI')
  })()

  await gui.fill('.topbar input[placeholder="https://sistema.ejemplo.com"]', SITE)
  await gui.click('button:has-text("Abrir")')

  for (let i = 0; i < 80; i++) {
    const st = await gui.evaluate(() => window.docrecorder.invoke('engine:get-state'))
    if (st.attached) break
    await new Promise((r) => setTimeout(r, 250))
  }

  const target = await (async () => {
    for (let i = 0; i < 60; i++) {
      const p = ctx.pages().find((p) => p.url().startsWith('https://'))
      if (p) return p
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('El viewport no cargó el sitio')
  })()
  console.log('sitio:', await target.title())

  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )

  // Interacciones genéricas: enlaces de navegación (App Router hace navegación
  // cliente) y cualquier control con nombre accesible.
  const clickables = target.locator('a[href^="/"], header button, nav button')
  const total = await clickables.count()
  console.log(`elementos navegables detectados: ${total}`)

  let done = 0
  for (let i = 0; i < total && done < 3; i++) {
    const el = clickables.nth(i)
    try {
      if (!(await el.isVisible())) continue
      await el.click({ timeout: 3000 })
      done++
      await new Promise((r) => setTimeout(r, 2500))
    } catch {
      /* elemento tapado o que abre otra pestaña: se salta */
    }
  }

  await new Promise((r) => setTimeout(r, 2000))
  const steps = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-card')].map((card) => ({
      title: card.querySelector('.step-title')?.value,
      strategy: card.querySelector('.selector-chip b')?.textContent,
      selector: card.querySelector('.selector-chip code')?.textContent,
      shotLoaded: card.querySelector('.thumb img')?.naturalWidth > 0
    }))
  )
  console.log(JSON.stringify(steps, null, 2))

  const raw = await gui.evaluate(() => window.__lastSteps ?? null)
  void raw

  const problems = []
  if (steps.length === 0) problems.push('no se registró ningún paso')
  if (steps.some((s) => !s.shotLoaded)) problems.push('alguna captura no cargó')
  const hashed = steps.filter((s) => /__[a-z0-9]{5,}|[a-f0-9]{8,}/i.test(s.selector ?? ''))
  if (hashed.length)
    problems.push(`selectores con aspecto hasheado: ${hashed.map((h) => h.selector).join(', ')}`)

  console.log(problems.length ? `\n⚠ ${problems.join(' | ')}` : '\n✔ Sin problemas detectados')
  process.exitCode = problems.length ? 1 : 0
  void statSync
} catch (err) {
  console.error('✘', err.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  child.kill('SIGTERM')
  setTimeout(() => process.exit(process.exitCode ?? 0), 600)
}
