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
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  rmSync
} from 'node:fs'
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

// La carpeta de salida es un repositorio Git: así se ejercita la fase de
// integración igual que lo haría el repo Docusaurus del otro desarrollador.
const g = (args) => execSync(`git ${args}`, { cwd: outDir, encoding: 'utf8' }).trim()
execSync('git init -q -b main', { cwd: outDir })
g('config user.email prueba@ejemplo.com')
g('config user.name Prueba')
writeFileSync(join(outDir, 'README.md'), '# Documentación\n')
g('add README.md')
g('commit -q -m "chore: repositorio de documentación inicial"')
console.log('repo de prueba en main con 1 commit')

// Una ejecución anterior interrumpida dejaría el puerto ocupado y la prueba
// se conectaría a esa instancia en vez de a la nueva.
try {
  execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' })
} catch {}

// userData propio: la prueba no toca los datos reales del usuario (borrador,
// registro de proyectos, preferencias), y arranca siempre desde cero.
const userData = mkdtempSync(join(tmpdir(), 'docrecorder-userdata-'))
const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DOCRECORDER_USER_DATA: userData }
})
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

  // El aviso de inicio de Docusaurus puede estar abierto (según la preferencia
  // guardada); si lo está, bloquea la barra, así que se cierra antes de seguir.
  if (await gui.locator('.intro-modal').count()) {
    check(true, 'Etapa 1: el aviso inicial de Docusaurus aparece al arrancar')
    await gui.getByRole('button', { name: 'Entendido' }).click()
    await gui.waitForSelector('.intro-modal', { state: 'detached', timeout: 3000 })
  }

  check(
    ctx.pages().some((p) => p.url() === 'about:blank'),
    'Etapa 1: el WebContentsView existe como target CDP'
  )
  // Sin página, el hueco muestra el onboarding (no un about:blank vacío).
  check(
    await gui.locator('.viewport-empty').isVisible(),
    'Etapa 1: el estado inicial muestra la guía de inicio'
  )

  // Se desactiva «agrupar campos» para que las etapas 3-6 registren un paso por
  // campo (comportamiento del motor). La agrupación se prueba aparte, más abajo.
  check(
    (await gui.locator('.group-toggle input').count()) > 0,
    'Etapa 1: existe el interruptor de agrupar campos'
  )
  if (await gui.locator('.group-toggle input').isChecked()) {
    await gui.locator('.group-toggle input').uncheck()
  }

  // --- Etapa 2: abrir la URL y adjuntar el motor por CDP ---
  await gui.fill('.topbar input[placeholder="https://sistema.ejemplo.com"]', fixture.url)
  await gui.click('button:has-text("Abrir")')
  // Al abrir, el visor se activa y el onboarding deja paso a la página.
  await gui.waitForSelector('.viewport-empty', { state: 'detached', timeout: 10000 })
  check(true, 'Etapa 2: al abrir una URL, el onboarding se oculta y aparece el visor')

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

  // --- Fase Git: detección y activación ---
  await gui.waitForSelector('.git-section', { timeout: 10000 })
  const detected = await gui.locator('.git-toggle em').textContent()
  check(
    /rama actual\s*main/.test(detected),
    'Git: repositorio detectado desde la carpeta de salida',
    detected
  )

  await gui.locator('.git-section input[type="checkbox"]').first().check()
  await gui.waitForSelector('.git-fields', { timeout: 5000 })
  const suggested = await gui.locator('.git-fields .field input').first().inputValue()
  check(
    suggested === 'docs/matriculas',
    'Git: rama sugerida = una por módulo (docs/<módulo>)',
    suggested
  )
  const suggestedMsg = await gui.locator('.git-fields .field input').nth(1).inputValue()
  check(
    suggestedMsg === 'docs(matriculas): Crear una matrícula',
    'Git: mensaje de commit sugerido',
    suggestedMsg
  )
  const pushDisabled = await gui.locator('.git-toggle.small input').isDisabled()
  check(pushDisabled, 'Git: el push queda deshabilitado sin remoto «origin»')

  // El campo Rama ofrece las ramas existentes como sugerencia (aquí solo `main`).
  await gui.waitForFunction(
    () => document.querySelectorAll('#git-branches option').length > 0,
    null,
    {
      timeout: 5000
    }
  )
  const branchOptions = await gui
    .locator('#git-branches option')
    .evaluateAll((os) => os.map((o) => o.value))
  check(
    branchOptions.includes('main'),
    'Git: el campo Rama lista las ramas existentes del repositorio',
    branchOptions.join(', ')
  )

  // El autoguardado ya debe haber escrito un borrador con los pasos grabados.
  const draftBefore = await gui.evaluate(() => window.docrecorder.invoke('draft:load'))
  check(
    !!draftBefore && draftBefore.steps.length > 0,
    'Borrador: la grabación en curso se autoguarda',
    draftBefore ? `${draftBefore.steps.length} paso(s)` : 'sin borrador'
  )
  // Las capturas del borrador se copian a una carpeta durable (no la temporal).
  check(
    !!draftBefore && draftBefore.steps.every((s) => /\/draft\/img\//.test(s.tempFile)),
    'Borrador: las capturas se guardan en una carpeta durable'
  )

  await gui.click('.ctrl:nth-child(3)')
  await gui.waitForSelector('.dialog', { timeout: 20000 })
  // Con Git activo, al detener aparece primero el aviso de que se registrará en
  // Git (con la rama), y permite cancelar para seguir grabando.
  const commitDialog = await gui.locator('.dialog').textContent()
  check(
    /registrar en Git/i.test(commitDialog) && commitDialog.includes('docs/matriculas'),
    'Etapa 6: al detener, se avisa del commit antes de registrarlo',
    (commitDialog.match(/Rama:[^\n]*/) ?? [''])[0]
  )
  await gui.click('.dialog .btn.primary') // "Registrar en Git"
  await gui.waitForFunction(
    () => document.querySelector('.dialog h3')?.textContent?.includes('guardada'),
    null,
    { timeout: 20000 }
  )
  const finalDialog = {
    title: await gui.locator('.dialog h3').textContent(),
    body: await gui.locator('.dialog p').textContent()
  }
  check(
    finalDialog.title.includes('guardada'),
    'Etapa 6: la sesión se guarda',
    `${finalDialog.title}: ${finalDialog.body}`
  )
  // Al guardar con éxito, el borrador se descarta (ya está en Git).
  const draftAfter = await gui.evaluate(() => window.docrecorder.invoke('draft:load'))
  check(draftAfter === null, 'Borrador: se descarta al guardar con éxito', String(draftAfter))

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

  // --- Fase Git: rama, commit y salvaguardas ---
  const branchNow = g('rev-parse --abbrev-ref HEAD')
  check(branchNow === 'docs/matriculas', 'Git: rama creada y activa', branchNow)

  const subject = g('log -1 --pretty=%s')
  check(
    subject === 'docs(matriculas): Crear una matrícula',
    'Git: commit con el mensaje indicado',
    subject
  )

  const committed = g('show --stat --name-only --pretty=format: HEAD')
    .split('\n')
    .filter(Boolean)
    .sort()
  check(
    committed.includes('matriculas/crear-matricula/session.json') &&
      committed.includes('matriculas/crear-matricula/flow.json') &&
      committed.filter((f) => f.endsWith('.png')).length === 4,
    'Git: el commit contiene session.json, flow.json y las 4 capturas',
    committed.join(' ')
  )
  check(
    committed.includes('matriculas/crear-matricula/index.mdx') &&
      committed.includes('matriculas/_category_.json'),
    'Docusaurus: el commit incluye la página MDX y la categoría del módulo',
    committed.filter((f) => f.endsWith('.mdx') || f.endsWith('_category_.json')).join(' ')
  )
  // La página MDX debe tener frontmatter y un encabezado numerado por paso.
  const mdx = g('show HEAD:matriculas/crear-matricula/index.mdx')
  check(
    /^---[\s\S]*title:/.test(mdx) &&
      /## 1\. /.test(mdx) &&
      mdx.includes('![') &&
      mdx.includes('](./img/'),
    'Docusaurus: la página MDX tiene frontmatter, pasos numerados y capturas',
    mdx.split('\n').slice(0, 6).join(' | ')
  )

  const cleanAfter = g('status --porcelain')
  check(cleanAfter === '', 'Git: no quedan cambios sin registrar', cleanAfter || '(limpio)')

  const mainUntouched = g('log main --oneline').split('\n').length
  check(mainUntouched === 1, 'Git: la rama main queda intacta', `${mainUntouched} commit(s)`)

  // Salvaguarda: un archivo ajeno ya indexado debe abortar el commit.
  writeFileSync(join(outDir, 'AJENO.md'), 'trabajo en curso de otra persona\n')
  g('add AJENO.md')
  const headBeforeGuard = g('rev-parse HEAD')
  const guard = await gui.evaluate(
    ([dir, steps]) =>
      window.docrecorder.invoke('session:save', {
        meta: {
          module: 'matriculas',
          feature: 'otra',
          title: 'Otra',
          role: 'x',
          baseUrl: 'http://x'
        },
        viewport: { width: 800, height: 600 },
        sessionId: 'test-guard',
        createdAt: new Date().toISOString(),
        outputDir: dir,
        steps,
        git: { enabled: true, branch: 'docs/otra', message: 'docs: otra', push: false }
      }),
    [outDir, await gui.evaluate(() => [])]
  )
  check(
    !!guard.gitError && /ya indexados/.test(guard.gitError),
    'Git: se aborta el commit si hay cambios ajenos en el índice',
    guard.gitError?.slice(0, 60)
  )
  check(
    g('rev-parse HEAD') === headBeforeGuard,
    'Git: la salvaguarda no dejó ningún commit a medias'
  )
  check(
    existsSync(join(outDir, 'matriculas', 'otra', 'session.json')),
    'Git: el paquete en disco se escribe aunque el commit falle'
  )

  // Otra funcionalidad del MISMO módulo reutiliza su rama (docs/<módulo>) y
  // acumula el commit encima: es la estrategia por módulo.
  g('reset -q HEAD AJENO.md')
  const reuse = await gui.evaluate(
    (dir) =>
      window.docrecorder.invoke('session:save', {
        meta: {
          module: 'matriculas',
          feature: 'editar-matricula',
          title: 'Editar una matrícula',
          role: 'secretaria',
          baseUrl: 'http://x'
        },
        viewport: { width: 800, height: 600 },
        sessionId: 'test-reuse',
        createdAt: new Date().toISOString(),
        outputDir: dir,
        steps: [],
        git: {
          enabled: true,
          branch: 'docs/matriculas',
          message: 'docs(matriculas): Editar una matrícula',
          push: false
        }
      }),
    outDir
  )
  check(
    !reuse.gitError && reuse.git?.createdBranch === false,
    'Git: otra funcionalidad del módulo reutiliza y acumula en su rama',
    reuse.gitError ?? reuse.git?.message
  )

  // Una rama DISTINTA (aquí forzada con nombre explícito, como sería otro módulo)
  // debe nacer de main, no encadenarse sobre la rama activa: si se encadenara, su
  // PR arrastraría la documentación anterior y los dos quedarían enredados.
  const second = await gui.evaluate(
    (dir) =>
      window.docrecorder.invoke('session:save', {
        meta: {
          module: 'matriculas',
          feature: 'anular-matricula',
          title: 'Anular una matrícula',
          role: 'secretaria',
          baseUrl: 'http://x'
        },
        viewport: { width: 800, height: 600 },
        sessionId: 'test-segunda',
        createdAt: new Date().toISOString(),
        outputDir: dir,
        steps: [],
        git: {
          enabled: true,
          branch: 'docs/matriculas-anular-matricula',
          message: 'docs(matriculas): anular',
          push: false
        }
      }),
    outDir
  )
  // El PADRE del commit, no `merge-base`: main también es antepasado de una rama
  // encadenada, así que `merge-base` daría por bueno justo el caso que falla.
  const parent = g('rev-parse docs/matriculas-anular-matricula^')
  const mainHead = g('rev-parse main')
  check(
    !second.gitError && parent === mainHead,
    'Git: la segunda funcionalidad nace de main, no de la rama anterior',
    second.gitError ?? `padre ${parent.slice(0, 7)} | main ${mainHead.slice(0, 7)}`
  )
  const secondTree = g('ls-tree -r --name-only docs/matriculas-anular-matricula')
  check(
    !secondTree.includes('matriculas/crear-matricula/'),
    'Git: la rama de la segunda funcionalidad no arrastra la documentación de la primera',
    secondTree.split('\n').filter(Boolean).join(' ')
  )

  // --- Explorador de repositorios (solo lectura) ---

  const branches = await gui.evaluate(
    (root) => window.docrecorder.invoke('git:branches', root),
    outDir
  )
  const byName = Object.fromEntries(branches.map((b) => [b.name, b]))
  check(
    !!byName['main'] && !!byName['docs/matriculas'],
    'Explorador: lista las ramas locales del repositorio',
    branches.map((b) => b.name).join(', ')
  )
  check(
    byName['docs/matriculas-anular-matricula']?.aheadOfDefault === 1,
    'Explorador: cuenta los commits que la rama aporta sobre la rama por defecto',
    String(byName['docs/matriculas-anular-matricula']?.aheadOfDefault)
  )

  const history = await gui.evaluate(
    (root) =>
      window.docrecorder.invoke('git:commits', {
        repoRoot: root,
        branch: 'docs/matriculas-anular-matricula'
      }),
    outDir
  )
  check(
    history[0]?.subject === 'docs(matriculas): anular',
    'Explorador: lee el historial de la rama, del commit más reciente hacia atrás',
    history[0]?.subject
  )
  // El asunto de un commit puede contener el separador de campos; si el formato
  // se parseara con `|` u otro carácter imprimible, aquí se partiría mal.
  check(
    history.every((c) => c.hash && c.date),
    'Explorador: cada commit trae hash y fecha bien separados',
    `${history.length} commit(s)`
  )

  const registered = await gui.evaluate(() => window.docrecorder.invoke('projects:list'))
  check(
    registered.some((p) => p.root === g('rev-parse --show-toplevel')),
    'Explorador: el repositorio queda registrado al commitear',
    registered.map((p) => p.label).join(', ')
  )

  // --- Renderizado del modal (lo que los checks IPC de arriba NO cubren) ---
  // Un fallo de React —JSX roto, onClick sin cablear, columnas colapsadas—
  // pasaría todos los checks anteriores y aun así dejaría la ventana inservible.
  // Aquí se maneja el DOM real, con esperas web-first en vez de tiempos fijos.

  // El diálogo de guardado sigue abierto y su overlay taparía el clic; se cierra
  // con «Cerrar» antes de tocar la barra superior.
  await gui.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await gui.waitForSelector('.overlay', { state: 'detached', timeout: 5000 })
  await gui.getByRole('button', { name: 'Proyectos…', exact: true }).click()
  await gui.waitForSelector('.projects-modal', { timeout: 5000 })
  check(
    (await gui.locator('.projects-col').count()) === 3,
    'Modal: se pintan las tres columnas (proyectos → ramas → historial)'
  )

  // La rama activa del repo de la sesión debe aparecer en la columna de ramas.
  await gui.waitForSelector('.projects-col:nth-child(2) .row', { timeout: 5000 })
  const uiBranches = await gui.locator('.projects-col:nth-child(2) .row b').allInnerTexts()
  check(
    uiBranches.some((b) => b.includes('main')),
    'Modal: la columna de ramas lista las ramas del repositorio',
    uiBranches.join(' | ')
  )

  // Seleccionar una rama debe cargar su historial en la tercera columna: es la
  // cadena de eventos completa (click → IPC → estado → render).
  await gui.locator('.projects-col:nth-child(2) .row').first().click()
  await gui.waitForSelector('.projects-col:nth-child(3) .commits li', { timeout: 5000 })
  check(
    (await gui.locator('.projects-col:nth-child(3) .commits li').count()) > 0,
    'Modal: al elegir una rama se pinta su historial de commits'
  )

  // Escoger la base escribe en el store y el modal se cierra: se comprueba el
  // efecto, no el DOM interno.
  await gui.locator('.projects-modal footer button').first().click()
  await gui.waitForSelector('.projects-modal', { state: 'detached', timeout: 5000 })
  const baseChosen = await gui.evaluate(() => document.querySelector('.projects-modal') === null)
  check(baseChosen, 'Modal: la acción del pie cierra la ventana')

  // --- Rama base elegida a mano: continuar una línea ya empezada ---

  const onto = await gui.evaluate(
    (dir) =>
      window.docrecorder.invoke('session:save', {
        meta: {
          module: 'matriculas',
          feature: 'anular-parcial',
          title: 'Anular parcialmente',
          role: 'secretaria',
          baseUrl: 'http://x'
        },
        viewport: { width: 800, height: 600 },
        sessionId: 'test-base',
        createdAt: new Date().toISOString(),
        outputDir: dir,
        steps: [],
        git: {
          enabled: true,
          branch: 'docs/matriculas-anular-parcial',
          message: 'docs(matriculas): anular parcial',
          push: false,
          baseBranch: 'docs/matriculas-anular-matricula'
        }
      }),
    outDir
  )
  check(
    !onto.gitError &&
      g('rev-parse docs/matriculas-anular-parcial^') ===
        g('rev-parse docs/matriculas-anular-matricula'),
    'Rama base elegida: la rama nueva nace de la indicada, no de la por defecto',
    onto.gitError ?? onto.git?.message
  )

  // Olvidar deja el registro como estaba y no toca el repositorio: si no, cada
  // ejecución de esta prueba dejaría residuos en los datos de la aplicación.
  const root = g('rev-parse --show-toplevel')
  const afterForget = await gui.evaluate(
    (r) => window.docrecorder.invoke('projects:forget', r),
    root
  )
  check(
    !afterForget.some((p) => p.root === root),
    'Explorador: olvidar un proyecto lo quita del registro'
  )
  check(
    existsSync(join(outDir, '.git')) && g('rev-parse --abbrev-ref HEAD').length > 0,
    'Explorador: olvidar un proyecto no toca el repositorio en disco'
  )

  // --- Franja de estado y panel colapsable ---

  await gui.waitForFunction(
    () => document.querySelector('.project-status')?.textContent?.includes('rama'),
    null,
    { timeout: 5000 }
  )
  const statusText = (await gui.locator('.project-status').textContent()).replace(/\s+/g, ' ')
  check(
    /rama\s*main/.test(statusText) && /próxima grabación/.test(statusText),
    'Estado: la franja resume repositorio, rama y base de la próxima grabación',
    statusText
  )

  // El valor de la prueba está aquí: colapsar debe DEVOLVER ancho al viewport,
  // que es lo que evita que la página responsive colapse su menú lateral.
  const slotWidth = () =>
    gui.locator('.viewport-slot').evaluate((n) => Math.round(n.getBoundingClientRect().width))
  const widthOpen = await slotWidth()

  await gui.locator('.panel-header .strip-toggle').click()
  await gui.waitForSelector('.panel.collapsed', { timeout: 3000 })
  const widthCollapsed = await slotWidth()
  check(
    widthCollapsed > widthOpen + 200,
    'Panel colapsable: al colapsar, el viewport recupera ancho',
    `abierto ${widthOpen}px → colapsado ${widthCollapsed}px`
  )
  check(
    (await gui.locator('.panel-strip .ctrl').count()) === 3,
    'Panel colapsable: la tira conserva los controles de grabación'
  )

  await gui.locator('.panel-strip .strip-toggle').click()
  await gui.waitForSelector('.panel:not(.collapsed)', { timeout: 3000 })
  check(
    Math.abs((await slotWidth()) - widthOpen) < 4,
    'Panel colapsable: al expandir, el viewport vuelve a su ancho'
  )

  // --- Tema claro/oscuro ---
  const themeState = () =>
    gui.evaluate(() => ({
      attr: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.body).backgroundColor,
      saved: localStorage.getItem('docrecorder.theme')
    }))
  const themeBefore = await themeState()
  await gui.getByRole('button', { name: /Cambiar a modo/ }).click()
  const themeAfter = await themeState()
  check(
    themeAfter.attr !== themeBefore.attr && themeAfter.bg !== themeBefore.bg,
    'Tema: el interruptor cambia data-theme y el fondo real',
    `${themeBefore.attr}(${themeBefore.bg}) → ${themeAfter.attr}(${themeAfter.bg})`
  )
  check(
    themeAfter.saved === themeAfter.attr,
    'Tema: la elección se persiste para el próximo arranque',
    themeAfter.saved
  )

  // --- Centro de ayuda ---
  await gui.getByRole('button', { name: 'Abrir la ayuda' }).click()
  await gui.waitForSelector('.help-modal', { timeout: 5000 })
  const navCount = await gui.locator('.help-nav button').count()
  const sectionCount = await gui.locator('.help-content section').count()
  check(
    navCount === sectionCount && navCount >= 10,
    'Ayuda: cada tema de la navegación tiene su sección',
    `${navCount} temas / ${sectionCount} secciones`
  )
  // Navegar a un tema debe moverlo al estado activo (scroll-spy + clic).
  await gui.getByRole('button', { name: 'Salida y Docusaurus' }).click()
  await gui.waitForTimeout(800)
  const activeTopic = await gui.locator('.help-nav button.active').textContent()
  check(
    activeTopic === 'Salida y Docusaurus' && (await gui.locator('.help-tree').first().isVisible()),
    'Ayuda: navegar a un tema lo resalta y muestra su contenido',
    `activo: ${activeTopic}`
  )
  await gui.keyboard.press('Escape')
  await gui.waitForSelector('.help-modal', { state: 'detached', timeout: 3000 })
  check(true, 'Ayuda: se cierra con Escape')

  // --- Aviso: carpeta = raíz de un Docusaurus ---
  const dsRoot = mkdtempSync(join(tmpdir(), 'docusaurus-'))
  writeFileSync(join(dsRoot, 'docusaurus.config.js'), 'module.exports = {}\n')
  mkdirSync(join(dsRoot, 'docs'), { recursive: true })
  const suggestedDocs = await gui.evaluate(
    (dir) => window.docrecorder.invoke('docusaurus:suggest-docs', dir),
    dsRoot
  )
  check(
    suggestedDocs === join(dsRoot, 'docs'),
    'Docusaurus: apuntar a la raíz sugiere la carpeta docs/',
    suggestedDocs
  )
  const noSuggest = await gui.evaluate(
    (dir) => window.docrecorder.invoke('docusaurus:suggest-docs', dir),
    join(dsRoot, 'docs')
  )
  check(
    noSuggest === null,
    'Docusaurus: apuntar ya dentro de docs/ no genera aviso',
    String(noSuggest)
  )

  // --- Agrupar campos: la página MDX lista los campos del formulario ---
  // Un paso agrupado (con `fields`) debe rendersizarse como una lista en el MDX,
  // en vez de una captura y un paso por campo.
  await gui.evaluate(
    (dir) =>
      window.docrecorder.invoke('session:save', {
        meta: {
          module: 'formularios',
          feature: 'con-campos',
          title: 'Formulario con campos',
          role: 'admin',
          baseUrl: 'http://x'
        },
        viewport: { width: 800, height: 600 },
        sessionId: 'test-fields',
        createdAt: new Date().toISOString(),
        outputDir: dir,
        steps: [
          {
            id: 'f1',
            order: 1,
            action: 'fill',
            title: 'Rellenar el formulario',
            description: '',
            selectorCandidates: [],
            url: 'http://x',
            screenshot: 'img/paso-01.png',
            boundingRect: { x: 0, y: 0, width: 1, height: 1 },
            includeInDocs: true,
            timestamp: 't',
            tempFile: '',
            fields: [
              { label: 'Nombre', value: 'ACME' },
              { label: 'Clave', value: '***' },
              { label: 'Fecha', value: '' }
            ]
          }
        ]
      }),
    outDir
  )
  const fieldsMdx = readFileSync(join(outDir, 'formularios', 'con-campos', 'index.mdx'), 'utf8')
  check(
    fieldsMdx.includes('- **Nombre:** ACME') &&
      fieldsMdx.includes('- **Clave:** ***') &&
      // Un campo solo enfocado (sin valor) se lista sin «: valor».
      fieldsMdx.includes('- **Fecha**\n') &&
      !fieldsMdx.includes('- **Fecha:**'),
    'Agrupar campos: la página MDX lista los campos (con y sin valor)',
    fieldsMdx
      .split('\n')
      .filter((l) => l.startsWith('- **'))
      .join(' | ')
  )

  // Restaura la preferencia de agrupar para no dejarla desactivada en la app real.
  await gui.evaluate(() => localStorage.removeItem('docrecorder.groupFormFields')).catch(() => {})

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
  rmSync(userData, { recursive: true, force: true })
  setTimeout(() => process.exit(process.exitCode ?? 0), 600)
}
