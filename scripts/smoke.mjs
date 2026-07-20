/**
 * Prueba de humo de extremo a extremo.
 *
 * Levanta la página de prueba (scripts/fixture), arranca la app compilada,
 * se conecta a la GUI por CDP y la maneja como lo haría una persona:
 * escribe la URL, graba, interactúa con el sistema de prueba y guarda.
 *
 *   npm run build && node scripts/smoke.mjs
 */
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { chromium } from 'playwright-core'
import { startFixtureServer } from './fixture/server.mjs'

const PORT = 9333
const root = process.cwd()

const checks = []
function check(ok, label, detail = '') {
  checks.push({ ok, label })
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function waitForCdp(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return await r.json()
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('El endpoint CDP no respondió')
}

const fixture = await startFixtureServer()
console.log('fixture:', fixture.url)

const outDir = mkdtempSync(join(tmpdir(), 'docrecorder-out-'))
console.log('salida:', outDir)

// Una ejecución anterior interrumpida dejaría el puerto ocupado y la prueba
// se conectaría a esa instancia en vez de a la nueva.
try {
  execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' })
} catch {}

const child = spawn(electronPath, ['.'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
child.stderr.on('data', (d) => {
  const s = String(d)
  if (!/DevTools listening|^\s*$/.test(s)) process.stderr.write(`[main:err] ${s}`)
})

let browser
try {
  await waitForCdp()
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0]

  // --- Etapa 1: layout y viewport ---
  const gui = await (async () => {
    for (let i = 0; i < 40; i++) {
      const p = ctx.pages().find((p) => /index\.html|localhost:\d+/.test(p.url()))
      if (p && (await p.locator('.topbar').count())) return p
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('No apareció la GUI')
  })()
  check(true, 'Etapa 1: GUI con barra superior y panel de pasos')
  check(
    ctx.pages().some((p) => p.url() === 'about:blank'),
    'Etapa 1: el WebContentsView existe como target CDP'
  )

  // --- Etapa 2: abrir la URL y adjuntar el motor por CDP ---
  await gui.fill('.topbar input[placeholder="https://sistema.ejemplo.com"]', fixture.url)
  await gui.click('button:has-text("Abrir")')

  const target = await (async () => {
    for (let i = 0; i < 60; i++) {
      const p = ctx
        .pages()
        .find((p) => p.url().startsWith('http://127.0.0.1:' + new URL(fixture.url).port))
      if (p) return p
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('El viewport no cargó la página de prueba')
  })()
  check(true, 'Etapa 2: el viewport navegó a la página de prueba', await target.title())

  let state
  for (let i = 0; i < 60; i++) {
    state = await gui.evaluate(() => window.docrecorder.invoke('engine:get-state'))
    if (state.attached) break
    await new Promise((r) => setTimeout(r, 250))
  }
  check(state.attached, 'Etapa 2: Playwright adjunto al viewport vía CDP', state.error ?? '')

  // --- Etapas 3 y 4: grabar interacciones reales sobre la página de prueba ---
  await gui.fill('.topbar input[placeholder="matriculas"]', 'matriculas')
  await gui.fill('.topbar input[placeholder="crear-matricula"]', 'crear-matricula')
  await gui.fill('.topbar input[placeholder="Crear una matrícula"]', 'Crear una matrícula')
  await gui.fill('.topbar input[placeholder="secretaria"]', 'secretaria')
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  check(true, 'Etapa 3: la grabación arranca y el estado pasa a «Grabando»')

  const stepCount = async () => Number(await gui.locator('.panel-header .count').textContent())
  const waitSteps = async (n, label) => {
    for (let i = 0; i < 60; i++) {
      if ((await stepCount()) >= n) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`Se esperaban ${n} pasos (${label}), hay ${await stepCount()}`)
  }

  // Clic sobre el botón con data-testid; el modal aparece 250 ms después, así
  // que también comprueba la espera de estabilidad del DOM.
  await target.click('[data-testid="nueva-matricula"]')
  await waitSteps(1, 'clic')

  // El modal vive en un contenedor portal fuera del árbol principal.
  await target.fill('#alumno', 'Ana Pérez')
  await target.fill('#clave', 'secreto123')
  await target.selectOption('#curso', '2b')
  await waitSteps(3, 'fill + fill + select')

  await target.click('button[type="submit"]')
  await waitSteps(5, 'clic en enviar')
  // Margen para comprobar que el evento `submit` NO genera un sexto paso.
  await new Promise((r) => setTimeout(r, 1500))

  // Las miniaturas se sirven por el protocolo docshot:; hay que esperar a que
  // el navegador las tenga decodificadas antes de comprobarlas.
  await gui.waitForFunction(
    () =>
      [...document.querySelectorAll('.thumb img')].every((i) => i.complete && i.naturalWidth > 0),
    null,
    { timeout: 15000 }
  )

  const steps = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-card')].map((card) => ({
      order: card.querySelector('.step-badge')?.textContent,
      action: card.querySelector('.action-chip')?.textContent,
      title: card.querySelector('.step-title')?.value,
      strategy: card.querySelector('.selector-chip b')?.textContent,
      selector: card.querySelector('.selector-chip code')?.textContent,
      value: card.querySelector('.step-value code')?.textContent,
      hasShot: !!card.querySelector('.thumb img')?.complete
    }))
  )
  console.log(JSON.stringify(steps, null, 2))

  check(
    steps.length === 5,
    'Etapa 3: una tarjeta por interacción, sin duplicar el submit',
    `${steps.length} pasos`
  )
  check(
    steps[0]?.strategy === 'test-id' && steps[0]?.selector === '[data-testid="nueva-matricula"]',
    'Etapa 4: selector preferido por data-testid'
  )
  check(
    steps.every((s) => s.hasShot),
    'Etapa 4: todos los pasos tienen captura cargada'
  )
  check(
    steps[1]?.value === 'Ana Pérez',
    'Etapa 3: el campo de texto se consolida en un paso',
    steps[1]?.value
  )
  check(steps[2]?.value === '***', 'Etapa 3: la contraseña queda enmascarada', steps[2]?.value)
  check(
    steps[3]?.action === 'seleccionar' && steps[3]?.value === '2º B',
    'Etapa 3: select registrado con su etiqueta'
  )

  const inModal = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-card')].some((c) =>
      c.querySelector('.selector-chip code')?.textContent?.includes('alumno')
    )
  )
  check(inModal, 'Etapa 4: elementos dentro del portal/modal resueltos correctamente')

  // --- Etapa 5: editar, reordenar y eliminar ---
  await gui.fill('.step-card:first-child .step-title', 'Abrir el formulario de matrícula')
  await gui.fill('.step-card:first-child .step-desc', 'Desde el listado, pulsa «Nueva matrícula».')
  const editedTitle = await gui.locator('.step-card:first-child .step-title').inputValue()
  check(editedTitle === 'Abrir el formulario de matrícula', 'Etapa 5: título editable')

  const before = await gui.locator('.step-card').count()
  await gui.locator('.step-card').last().locator('.icon-btn.danger').click()
  await gui.waitForFunction(
    (n) => document.querySelectorAll('.step-card').length === n - 1,
    before,
    { timeout: 5000 }
  )
  const after = await gui.locator('.step-card').count()
  check(after === before - 1, 'Etapa 5: eliminar paso', `${before} → ${after}`)

  const ordersAfterDelete = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-badge')].map((b) => b.textContent)
  )
  check(
    ordersAfterDelete.join(',') === '1,2,3,4',
    'Etapa 5: los pasos se renumeran tras eliminar',
    ordersAfterDelete.join(',')
  )

  // Reordenar arrastrando la tarjeta 1 por debajo de la 2.
  const titlesBefore = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-title')].map((i) => i.value)
  )
  const firstTitleBefore = titlesBefore[0]
  const handle = await gui.locator('.step-card').first().locator('.drag-handle').boundingBox()
  const secondCard = await gui.locator('.step-card').nth(1).boundingBox()
  await gui.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await gui.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await gui.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2 + (secondCard.height * i) / 12
    )
    await new Promise((r) => setTimeout(r, 25))
  }
  await gui.mouse.up()
  await new Promise((r) => setTimeout(r, 600))
  const titlesAfter = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-title')].map((i) => i.value)
  )
  check(
    titlesAfter[1] === firstTitleBefore,
    'Etapa 5: reordenar con arrastrar/teclado',
    `antes=[${titlesBefore.join(' | ')}] despues=[${titlesAfter.join(' | ')}]`
  )

  // --- Etapa 6: guardar a disco ---
  // El selector nativo de carpeta no es automatizable; el campo acepta rutas
  // escritas, que es como lo usaría alguien que documenta siempre en el mismo sitio.
  await gui.fill('.topbar input[placeholder="Sin seleccionar"]', outDir)

  await gui.click('.ctrl:nth-child(3)')
  await gui.waitForSelector('.dialog', { timeout: 20000 })
  const dialogTitle = await gui.locator('.dialog h3').textContent()
  if (dialogTitle?.includes('sin título')) {
    await gui.click('.dialog .btn.primary')
    await gui.waitForFunction(
      () => document.querySelector('.dialog h3')?.textContent?.includes('guardada'),
      null,
      { timeout: 20000 }
    )
  }
  const finalDialog = {
    title: await gui.locator('.dialog h3').textContent(),
    body: await gui.locator('.dialog p').textContent()
  }
  check(
    finalDialog.title.includes('guardada'),
    'Etapa 6: la sesión se guarda',
    `${finalDialog.title}: ${finalDialog.body}`
  )

  const dir = join(outDir, 'matriculas', 'crear-matricula')
  const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))
  const flow = JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8'))
  const images = readdirSync(join(dir, 'img')).sort()

  check(existsSync(join(dir, 'session.json')), 'Etapa 6: session.json escrito')
  check(existsSync(join(dir, 'flow.json')), 'Etapa 6: flow.json escrito')
  check(
    images.join(',') === 'paso-01.png,paso-02.png,paso-03.png,paso-04.png',
    'Etapa 6: imágenes renumeradas según el orden final',
    images.join(',')
  )
  check(
    session.steps.every((s, i) => s.order === i + 1 && s.screenshot === `img/paso-0${i + 1}.png`),
    'Etapa 6: orden de session.json coincide con el de disco'
  )
  check(
    session.steps[1]?.title === 'Abrir el formulario de matrícula',
    'Etapa 6: se persisten el título editado y el nuevo orden',
    session.steps.map((s) => s.title).join(' | ')
  )
  check(
    session.steps[1]?.description === 'Desde el listado, pulsa «Nueva matrícula».',
    'Etapa 6: la descripción editada se persiste'
  )
  check(
    flow.actions.length === session.steps.length,
    'Etapa 6: flow.json refleja las mismas acciones'
  )
  check(
    session.steps.every((s) => s.selectorCandidates.length >= 1),
    'Criterio 6: todo paso guarda al menos un selector'
  )
  check(
    session.steps.every((s) =>
      s.selectorCandidates.every((c) => !/[a-z]+_[a-z]+__[a-z0-9]{5}/i.test(c.value))
    ),
    'Criterio 6: ningún selector depende de clases hasheadas'
  )
  check(
    session.steps.every((s) => s.value !== 'secreto123'),
    'Criterio 3: la contraseña no se persiste en claro'
  )

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} comprobaciones OK`)
  process.exitCode = failed.length ? 1 : 0
} catch (err) {
  console.error('✘ error:', err.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  fixture.close()
  child.kill('SIGTERM')
  setTimeout(() => process.exit(process.exitCode ?? 0), 600)
}
