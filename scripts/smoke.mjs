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
import { inflateSync } from 'node:zlib'
import electronPath from 'electron'
import { chromium } from 'playwright-core'
import { startFixtureServer } from './fixture/server.mjs'

const PORT = 9333
const root = process.cwd()

/**
 * Decodificador PNG mínimo (8 bits, sin entrelazar), que es lo que produce
 * Playwright. Sirve para comprobar sobre los píxeles reales lo que ninguna
 * aserción del DOM puede: que el elemento señalado se VE en la captura.
 *
 * Se hace en Node y no con un canvas del renderer porque las capturas se sirven
 * por el protocolo `docshot://`, que es otro origen y contamina el canvas;
 * abrirle CORS solo para una prueba sería peor.
 */
/**
 * Cuántos recuadros de resaltado (#FF5722) hay en la captura.
 *
 * Se cuentan por bandas: cada recuadro ocupa un tramo de filas seguidas —sus
 * bordes laterales pintan de naranja todas las filas intermedias— y los elementos
 * de un formulario están apilados con hueco entre ellos. Es lo único que
 * demuestra, sobre los píxeles, que el paso agrupado señala a TODOS sus
 * elementos y no solo al último.
 */
function countHighlightBoxes(png) {
  const rows = []
  for (let y = 0; y < png.height; y++) {
    let orange = false
    for (let x = 0; x < png.width && !orange; x++) {
      const i = (y * png.width + x) * png.channels
      orange =
        Math.abs(png.data[i] - 255) < 30 &&
        Math.abs(png.data[i + 1] - 87) < 30 &&
        Math.abs(png.data[i + 2] - 34) < 30
    }
    rows.push(orange)
  }
  let bands = 0
  for (let y = 0; y < rows.length; y++) {
    if (rows[y] && !rows[y - 1]) bands++
  }
  return bands
}

function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let channels = 0
  const chunks = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0
      if (data[8] !== 8 || !channels || data[12] !== 0) throw new Error('PNG no soportado')
    } else if (type === 'IDAT') chunks.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  const zero = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : zero
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 255
    }
  }
  return { width, height, channels, data: out }
}

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
  // `DOCRECORDER_AI_FAKE` sustituye la llamada al proveedor de IA por una
  // respuesta determinista: la prueba recorre el circuito completo (ajustes →
  // IPC → aplicar en el panel) sin depender de la red ni de una clave real.
  // `DOCRECORDER_CAPTURE_FAKE` hace lo propio con la captura de pantalla: sin
  // ella dependería de qué ventanas haya abiertas y del permiso del sistema.
  env: {
    ...process.env,
    DOCRECORDER_USER_DATA: userData,
    DOCRECORDER_AI_FAKE: '1',
    DOCRECORDER_CAPTURE_FAKE: '1',
    // Descartar documentación manda los archivos a la papelera del sistema, que
    // es lo correcto para una persona y una guarrada para una prueba: iría
    // dejando carpetas temporales en la papelera de quien la ejecuta.
    DOCRECORDER_NO_TRASH: '1',
    // La vista previa abre el sitio en el navegador del usuario. Se comprueba
    // que la dirección responde, pero sin abrirle nada a quien ejecuta esto.
    DOCRECORDER_NO_OPEN: '1'
  }
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

  /**
   * Espera a que el panel se asiente en lo que se va a comprobar (una fusión
   * tarda lo que tarde la captura del grupo). No lanza si no llega: la
   * comprobación que viene detrás dirá qué había, que es más útil que un
   * timeout sin contexto. Sustituye a los tiempos fijos, que fallaban a ratos.
   */
  const settle = async (predicate, ms = 12000) => {
    await gui.waitForFunction(predicate, null, { timeout: ms }).catch(() => {})
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
  // La lista puede estar desplazada (cada paso nuevo se trae a la vista), y
  // entonces el asa de la primera tarjeta queda medio fuera del área visible: el
  // clic caería en el borde del panel y el arrastre no arrancaría. Se sube a la
  // tarjeta primero, que es lo que haría cualquiera antes de arrastrarla.
  await gui.locator('.step-card').first().scrollIntoViewIfNeeded()
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
  // Diagnóstico: si el arrastre no llega a mover la tarjeta, el detalle del
  // fallo debe decir si es que nunca arrancó (sin `transform`) o si arrancó y no
  // hubo intercambio. Sin esto, un fallo aquí no dice nada.
  const midDrag = await gui.evaluate(
    () => document.querySelector('.step-card')?.style.transform || '(sin transform)'
  )
  await gui.mouse.up()
  await new Promise((r) => setTimeout(r, 600))
  const titlesAfter = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-title')].map((i) => i.value)
  )
  check(
    titlesAfter[1] === firstTitleBefore,
    'Etapa 5: reordenar con arrastrar/teclado',
    `antes=[${titlesBefore.join(' | ')}] despues=[${titlesAfter.join(' | ')}] arrastre=${midDrag}`
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
  // `draft:clear` viaja sin esperar a que termine, y el main atiende los canales
  // en paralelo: leerlo una sola vez llegaría a veces antes del borrado.
  const draftAfter = await gui.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      const d = await window.docrecorder.invoke('draft:load')
      if (d === null) return null
      await new Promise((r) => setTimeout(r, 100))
    }
    return window.docrecorder.invoke('draft:load')
  })
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

  // La rama sabe lo que documenta: de aquí salen los metadatos con los que se
  // retoma una rama sin volver a escribirlos.
  const branchDocs = await gui.evaluate(
    (root) =>
      window.docrecorder.invoke('git:branch-docs', { repoRoot: root, branch: 'docs/matriculas' }),
    outDir
  )
  check(
    branchDocs[0]?.feature === 'editar-matricula' &&
      branchDocs.some((d) => d.feature === 'crear-matricula'),
    'Rama de trabajo: lista lo documentado en la rama, de lo más reciente a lo más antiguo',
    branchDocs.map((d) => d.feature).join(', ')
  )
  check(
    branchDocs[0]?.module === 'matriculas' && branchDocs[0]?.role === 'secretaria',
    'Rama de trabajo: cada entrada trae módulo y rol para recuperarlos',
    `${branchDocs[0]?.module} / ${branchDocs[0]?.role}`
  )
  const otherBranchDocs = await gui.evaluate(
    (root) =>
      window.docrecorder.invoke('git:branch-docs', {
        repoRoot: root,
        branch: 'docs/matriculas-anular-matricula'
      }),
    outDir
  )
  check(
    otherBranchDocs.length === 1 && otherBranchDocs[0].feature === 'anular-matricula',
    'Rama de trabajo: cada rama solo ve su propia documentación',
    otherBranchDocs.map((d) => d.feature).join(', ')
  )

  // --- Documentación escrita en el repositorio y sin registrar en Git ---
  // El caso real de un guardado que no llegó a comitearse (falló el commit, se
  // guardó con la integración desactivada o se cerró la app): el paquete está
  // entero en el disco pero fuera del historial, así que el árbol de la rama no
  // lo ve. La app tiene que poder leerlo y registrarlo después.
  const orphan = await gui.evaluate(
    (dir) =>
      window.docrecorder.invoke('session:save', {
        meta: {
          module: 'inventario',
          subcategory: '',
          feature: 'dar-de-baja',
          title: 'Dar de baja un bien',
          role: 'bodega',
          baseUrl: 'http://x'
        },
        viewport: { width: 800, height: 600 },
        sessionId: 'test-huerfano',
        createdAt: new Date().toISOString(),
        outputDir: dir,
        steps: [1, 2].map((n) => ({
          id: `h${n}`,
          order: n,
          action: 'click',
          title: `Paso ${n}`,
          description: '',
          selectorCandidates: [],
          url: 'http://x',
          boundingRect: { x: 0, y: 0, width: 0, height: 0 },
          includeInDocs: true,
          timestamp: new Date().toISOString()
        }))
        // Sin `git`: se escribe en disco y nadie comitea.
      }),
    outDir
  )
  // Una captura dentro de su `img/`: al leer lo pendiente hay que subir desde el
  // archivo hasta el paquete que lo contiene, no quedarse en su carpeta.
  writeFileSync(join(orphan.path, 'img', 'paso-01.png'), 'png-de-prueba')

  const readPending = () =>
    gui.evaluate((root) => window.docrecorder.invoke('git:pending-docs', root), outDir)
  const orphanInfo = (await readPending()).find((d) => d.feature === 'dar-de-baja')
  check(
    orphanInfo?.untracked === true &&
      orphanInfo.steps === 2 &&
      orphanInfo.dir === 'inventario/dar-de-baja',
    'Sin registrar: se lee un paquete escrito que Git no tiene en ningún commit',
    JSON.stringify({ dir: orphanInfo?.dir, pasos: orphanInfo?.steps })
  )
  check(
    orphanInfo?.pendingFiles.includes('inventario/dar-de-baja/img/paso-01.png'),
    'Sin registrar: las capturas de img/ cuentan como parte de su paquete',
    orphanInfo?.pendingFiles.join(' ')
  )

  const pendingCommit = await gui.evaluate(
    ([root, dir]) =>
      window.docrecorder.invoke('git:commit-pending', {
        repoRoot: root,
        dir,
        branch: 'docs/inventario',
        message: 'docs(inventario): Dar de baja un bien',
        push: false
      }),
    [outDir, 'inventario/dar-de-baja']
  )
  check(
    pendingCommit.commit !== null && pendingCommit.createdBranch,
    'Sin registrar: registrarlo crea su rama y hace el commit',
    pendingCommit.message
  )
  const pendingFilesCommitted = g('show --name-only --pretty=format: docs/inventario')
    .split('\n')
    .filter(Boolean)
  check(
    [
      'inventario/_category_.json',
      'inventario/dar-de-baja/index.mdx',
      'inventario/dar-de-baja/session.json',
      'inventario/dar-de-baja/flow.json',
      'inventario/dar-de-baja/img/paso-01.png'
    ].every((f) => pendingFilesCommitted.includes(f)),
    'Sin registrar: viaja el paquete entero, con su img/ y su _category_.json',
    pendingFilesCommitted.join(' ')
  )
  const afterRegister = await readPending()
  check(
    !afterRegister.some((d) => d.feature === 'dar-de-baja'),
    'Sin registrar: lo registrado deja de figurar como pendiente',
    afterRegister.map((d) => d.dir).join(' ') || '(nada pendiente)'
  )

  // El otro caso pendiente: ya commiteado, pero cambiado después en el disco.
  writeFileSync(join(outDir, 'inventario', 'dar-de-baja', 'index.mdx'), '# tocado a mano\n')
  const changedPending = (await readPending()).find((d) => d.feature === 'dar-de-baja')
  check(
    changedPending !== undefined && changedPending.untracked === false,
    'Sin registrar: también se ve un paquete commiteado y cambiado después',
    JSON.stringify(changedPending?.pendingFiles ?? [])
  )
  // Se deshace: un archivo seguido y sucio bloquearía el cambio de rama de los
  // guardados siguientes, que es justo la salvaguarda que la app aplica.
  g('checkout -- inventario/dar-de-baja/index.mdx')

  // --- Subcategoría (3 niveles) + nota destacada por paso ---
  const subSave = await gui.evaluate(
    (dir) =>
      window.docrecorder.invoke('session:save', {
        meta: {
          module: 'administracion',
          subcategory: 'institucion',
          feature: 'registrar-institucion',
          title: 'Registrar una institución',
          role: 'admin',
          baseUrl: 'http://x'
        },
        viewport: { width: 800, height: 600 },
        sessionId: 'test-subcat',
        createdAt: new Date().toISOString(),
        outputDir: dir,
        steps: [
          {
            id: 's1',
            order: 1,
            action: 'click',
            title: 'Abrir el formulario',
            description: '',
            selectorCandidates: [],
            url: 'http://x',
            boundingRect: { x: 0, y: 0, width: 0, height: 0 },
            includeInDocs: true,
            timestamp: new Date().toISOString(),
            note: {
              type: 'tip',
              title: 'Importante',
              body: 'Revisa el **RUC** antes de <mark>guardar</mark> si saldo < 0.'
            }
          }
        ],
        git: {
          enabled: true,
          branch: 'docs/administracion',
          message: 'docs(administracion): Registrar una institución',
          push: false
        }
      }),
    outDir
  )
  check(
    !subSave.gitError &&
      existsSync(
        join(outDir, 'administracion', 'institucion', 'registrar-institucion', 'index.mdx')
      ),
    'Subcategoría: la estructura es de tres niveles módulo/subcategoría/funcionalidad',
    subSave.gitError ?? subSave.path
  )
  const subCommitted = g('show --stat --name-only --pretty=format: docs/administracion')
    .split('\n')
    .filter(Boolean)
  check(
    subCommitted.includes('administracion/_category_.json') &&
      subCommitted.includes('administracion/institucion/_category_.json'),
    'Subcategoría: se crea un _category_.json por cada nivel (módulo y subcategoría)',
    subCommitted.filter((f) => f.endsWith('_category_.json')).join(' ')
  )
  const subMdx = g(
    'show docs/administracion:administracion/institucion/registrar-institucion/index.mdx'
  )
  check(
    /:::tip\[Importante\]/.test(subMdx) &&
      subMdx.includes('<mark>guardar</mark>') &&
      /^:::$/m.test(subMdx),
    'Nota: el paso publica un admonition de Docusaurus con su formato',
    subMdx.split('\n').find((l) => l.startsWith(':::')) ?? '(sin admonition)'
  )
  check(
    subMdx.includes('saldo &lt; 0') && !/saldo < 0/.test(subMdx),
    'Nota: un «<» suelto se escapa (no rompe el build) pero <mark> se conserva',
    subMdx.split('\n').find((l) => l.includes('saldo')) ?? '(sin línea)'
  )
  check(
    /\*\*Subcategoría:\*\* Institucion/.test(subMdx),
    'Subcategoría: la página refleja la subcategoría en su metadato',
    subMdx.split('\n').find((l) => l.includes('Subcategoría')) ?? '(sin línea)'
  )
  const subBranchDocs = await gui.evaluate(
    (root) =>
      window.docrecorder.invoke('git:branch-docs', {
        repoRoot: root,
        branch: 'docs/administracion'
      }),
    outDir
  )
  check(
    subBranchDocs[0]?.subcategory === 'institucion' &&
      subBranchDocs[0]?.feature === 'registrar-institucion',
    'Rama de trabajo: branch-docs expone la subcategoría de cada proceso',
    `${subBranchDocs[0]?.subcategory} / ${subBranchDocs[0]?.feature}`
  )

  const registered = await gui.evaluate(() => window.docrecorder.invoke('projects:list'))
  check(
    registered.some((p) => p.root === g('rev-parse --show-toplevel')),
    'Explorador: el repositorio queda registrado al commitear',
    registered.map((p) => p.label).join(', ')
  )

  // --- Vista previa: leer la documentación de un commit desde Git ---
  // El commit que documentó «crear-matricula» (el tip de docs/matriculas es la
  // regrabación de «editar», que se guardó sin pasos).
  const firstCommit = g(
    'log --format=%H -n1 docs/matriculas -- matriculas/crear-matricula/session.json'
  )
  const commitDocs = await gui.evaluate(
    ([root, commit]) => window.docrecorder.invoke('git:commit-docs', { repoRoot: root, commit }),
    [outDir, firstCommit]
  )
  const previewSession = commitDocs[0]?.session
  check(
    commitDocs.length > 0 &&
      previewSession?.feature === 'crear-matricula' &&
      previewSession.steps.length > 0,
    'Vista previa: se lee el session.json documentado en un commit',
    `${commitDocs.length} sesión(es), ${previewSession?.steps.length ?? 0} paso(s)`
  )
  const imgPath = `${commitDocs[0].path.replace(/session\.json$/, '')}${previewSession.steps[0].screenshot}`
  const dataUri = await gui.evaluate(
    ([root, commit, imagePath]) =>
      window.docrecorder.invoke('git:doc-image', { repoRoot: root, commit, imagePath }),
    [outDir, firstCommit, imgPath]
  )
  check(
    typeof dataUri === 'string' && dataUri.startsWith('data:image/png;base64,'),
    'Vista previa: la captura commiteada se lee de Git como data URI',
    dataUri ? `${dataUri.slice(0, 24)}… (${dataUri.length} b)` : 'null'
  )

  // --- Runner de regeneración: re-ejecutar el flujo y actualizar capturas ---
  // El diálogo de resultado de la Etapa 6 sigue abierto y oculta el visor; el
  // runner necesita el visor VISIBLE para capturar, así que se cierra primero.
  await gui.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await gui.waitForSelector('.overlay', { state: 'detached', timeout: 5000 })

  // --- Selector de rama de trabajo: retomar una rama sin reescribir la cabecera ---
  // Se vacía la cabecera, que es como se llega otro día: la rama existe, pero los
  // metadatos ya no están en pantalla.
  await gui.fill('.topbar input[placeholder="matriculas"]', '')
  await gui.fill('.topbar input[placeholder="crear-matricula"]', '')
  await gui.fill('.topbar input[placeholder="Crear una matrícula"]', '')
  await gui.fill('.topbar input[placeholder="secretaria"]', '')
  await gui.fill('.topbar input[placeholder="https://sistema.ejemplo.com"]', '')

  await gui.click('.branch-chip')
  await gui.waitForSelector('.branch-picker', { timeout: 5000 })
  await gui.waitForSelector('.branch-list .row[data-branch="docs/matriculas"]', { timeout: 5000 })
  await gui.click('.branch-list .row[data-branch="docs/matriculas"]')
  await gui.waitForFunction(
    () => document.querySelector('.branch-chip code')?.textContent === 'docs/matriculas',
    null,
    { timeout: 5000 }
  )
  const adopted = await gui.evaluate(() => ({
    module: document.querySelector('.topbar input[placeholder="matriculas"]').value,
    feature: document.querySelector('.topbar input[placeholder="crear-matricula"]').value,
    title: document.querySelector('.topbar input[placeholder="Crear una matrícula"]').value,
    role: document.querySelector('.topbar input[placeholder="secretaria"]').value,
    baseUrl: document.querySelector('.topbar input[placeholder="https://sistema.ejemplo.com"]')
      .value,
    gitBranch: document.querySelector('.git-fields .field input')?.value
  }))
  check(
    adopted.module === 'matriculas' &&
      adopted.role === 'secretaria' &&
      adopted.baseUrl === 'http://x',
    'Rama de trabajo: elegir una rama recupera módulo, rol y URL base de lo ya documentado',
    JSON.stringify(adopted)
  )
  check(
    adopted.feature === '' && adopted.title === '',
    'Rama de trabajo: funcionalidad y título quedan libres (se documenta una nueva)',
    `${adopted.feature} / ${adopted.title}`
  )
  check(
    adopted.gitBranch === 'docs/matriculas',
    'Rama de trabajo: el campo Rama de la sección Git refleja la misma elección',
    adopted.gitBranch
  )

  // Retomar una funcionalidad concreta sí carga sus cuatro campos: se va a
  // ampliar o regrabar, y debe caer en su misma carpeta.
  await gui.waitForSelector('.branch-docs .row[data-feature="crear-matricula"]', { timeout: 5000 })
  await gui.click('.branch-docs .row[data-feature="crear-matricula"]')
  await gui.waitForSelector('.branch-picker', { state: 'detached', timeout: 5000 })
  const reloaded = await gui.evaluate(() => ({
    feature: document.querySelector('.topbar input[placeholder="crear-matricula"]').value,
    title: document.querySelector('.topbar input[placeholder="Crear una matrícula"]').value
  }))
  check(
    reloaded.feature === 'crear-matricula' && reloaded.title === 'Crear una matrícula',
    'Rama de trabajo: retomar una funcionalidad carga sus metadatos completos',
    JSON.stringify(reloaded)
  )
  // Se escribe una funcionalidad con dos pasos: uno con selector válido (el botón
  // del fixture) y otro con selector inexistente, para probar ok + fallo marcado.
  // El visor sigue adjunto al fixture, así que el runner reutiliza esa sesión.
  const regenDir = mkdtempSync(join(tmpdir(), 'regen-'))
  const featureDir = join(regenDir, 'pruebas', 'regenerar')
  mkdirSync(join(featureDir, 'img'), { recursive: true })
  writeFileSync(
    join(featureDir, 'session.json'),
    JSON.stringify({
      id: 'r1',
      module: 'pruebas',
      feature: 'regenerar',
      title: 'Regenerar',
      role: '',
      baseUrl: fixture.url,
      viewport: { width: 800, height: 600 },
      createdAt: new Date().toISOString(),
      steps: [
        {
          id: 'a',
          order: 1,
          action: 'click',
          title: 'Abrir «Nueva matrícula»',
          description: '',
          selectorCandidates: [
            { strategy: 'testid', value: '[data-testid="nueva-matricula"]', score: 100 }
          ],
          url: fixture.url,
          screenshot: 'img/paso-01.png',
          boundingRect: { x: 0, y: 0, width: 1, height: 1 },
          includeInDocs: true,
          timestamp: 't'
        },
        {
          id: 'b',
          order: 2,
          action: 'click',
          title: 'Elemento que ya no existe',
          description: '',
          selectorCandidates: [{ strategy: 'css', value: '#no-existe-jamas', score: 10 }],
          url: fixture.url,
          screenshot: 'img/paso-02.png',
          boundingRect: { x: 0, y: 0, width: 1, height: 1 },
          includeInDocs: true,
          timestamp: 't'
        }
      ]
    }),
    'utf8'
  )
  const regen = await gui.evaluate(
    (dir) => window.docrecorder.invoke('runner:regenerate', dir),
    featureDir
  )
  check(
    !regen.error && regen.results.length === 2,
    'Runner: re-ejecuta el flujo de la funcionalidad',
    regen.error ?? `${regen.results.length} paso(s)`
  )
  check(
    regen.results[0]?.status === 'ok' && existsSync(join(featureDir, 'img', 'paso-01.png')),
    'Runner: regenera la captura del paso con selector válido'
  )
  check(
    regen.results[1]?.status === 'failed',
    'Runner: marca el paso cuyo elemento no se encuentra (no aborta)',
    regen.results[1]?.detail
  )
  rmSync(regenDir, { recursive: true, force: true })

  // --- Renderizado del modal (lo que los checks IPC de arriba NO cubren) ---
  // Un fallo de React —JSX roto, onClick sin cablear, columnas colapsadas—
  // pasaría todos los checks anteriores y aun así dejaría la ventana inservible.
  // Aquí se maneja el DOM real, con esperas web-first en vez de tiempos fijos.

  // El diálogo de resultado ya se cerró antes del runner; se abre el explorador.
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
    /rama de trabajo/.test(statusText) && /docs\/matriculas/.test(statusText),
    'Estado: la franja resume repositorio y rama de trabajo',
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

  // Regresión: el encabezado del panel ha ido ganando controles (agrupar campos,
  // redactar con IA…). Si no envuelve, los de grabación se salen por la derecha
  // y «detener y guardar» queda inalcanzable, que es la única salida del flujo.
  const controlsInside = await gui.evaluate(() => {
    const panel = document.querySelector('.panel')?.getBoundingClientRect()
    const ctrls = [...document.querySelectorAll('.panel-header .controls .ctrl')]
    if (!panel || ctrls.length !== 3) return null
    return ctrls.every((c) => {
      const r = c.getBoundingClientRect()
      return r.width > 0 && r.left >= panel.left - 1 && r.right <= panel.right + 1
    })
  })
  check(
    controlsInside === true,
    'Panel: los tres controles de grabación caben dentro del panel',
    String(controlsInside)
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
  await gui.waitForTimeout(2000)
  const activeTopic = await gui.locator('.help-nav button.active').textContent()
  check(
    activeTopic === 'Salida y Docusaurus' && (await gui.locator('.help-tree').first().isVisible()),
    'Ayuda: navegar a un tema lo resalta y muestra su contenido',
    `activo: ${activeTopic}`
  )
  await gui.keyboard.press('Escape')
  await gui.waitForSelector('.help-modal', { state: 'detached', timeout: 3000 })
  check(true, 'Ayuda: se cierra con Escape')

  // --- Retomar la rama al apuntar a un repositorio que quedó en ella ---
  // Es el caso de volver al día siguiente: el clon está en su rama de
  // documentación y la cabecera está vacía. Hace falta OTRO repositorio porque
  // la herencia se hace una sola vez por repositorio y ya ocurrió con el primero.
  const repo2 = mkdtempSync(join(tmpdir(), 'docrecorder-otro-'))
  const g2 = (args) => execSync(`git ${args}`, { cwd: repo2, encoding: 'utf8' }).trim()
  execSync('git init -q -b main', { cwd: repo2 })
  g2('config user.email prueba@ejemplo.com')
  g2('config user.name Prueba')
  writeFileSync(join(repo2, 'README.md'), '# Documentación\n')
  g2('add README.md')
  g2('commit -q -m "chore: repositorio de documentación inicial"')
  execSync('git checkout -q -b docs/tesoreria', { cwd: repo2 })
  mkdirSync(join(repo2, 'tesoreria', 'cobrar-cuota'), { recursive: true })
  writeFileSync(
    join(repo2, 'tesoreria', 'cobrar-cuota', 'session.json'),
    JSON.stringify({
      id: 't1',
      module: 'tesoreria',
      feature: 'cobrar-cuota',
      title: 'Cobrar una cuota',
      role: 'cajera',
      baseUrl: 'http://tesoreria.ejemplo',
      viewport: { width: 800, height: 600 },
      createdAt: new Date().toISOString(),
      steps: []
    })
  )
  g2('add tesoreria')
  g2('commit -q -m "docs(tesoreria): Cobrar una cuota"')

  await gui.fill('.topbar input[placeholder="matriculas"]', '')
  await gui.fill('.topbar input[placeholder="crear-matricula"]', '')
  await gui.fill('.topbar input[placeholder="Crear una matrícula"]', '')
  await gui.fill('.topbar input[placeholder="secretaria"]', '')
  await gui.fill('.topbar input[placeholder="https://sistema.ejemplo.com"]', '')
  await gui.fill('.topbar input[placeholder="Sin seleccionar"]', repo2)
  await gui
    .waitForFunction(
      () =>
        document.querySelector('.topbar input[placeholder="matriculas"]')?.value === 'tesoreria',
      null,
      { timeout: 15000 }
    )
    .catch(() => {})
  const inherited = await gui.evaluate(() => ({
    module: document.querySelector('.topbar input[placeholder="matriculas"]').value,
    role: document.querySelector('.topbar input[placeholder="secretaria"]').value,
    baseUrl: document.querySelector('.topbar input[placeholder="https://sistema.ejemplo.com"]')
      .value,
    branch: document.querySelector('.branch-chip code')?.textContent
  }))
  check(
    inherited.module === 'tesoreria' &&
      inherited.role === 'cajera' &&
      inherited.baseUrl === 'http://tesoreria.ejemplo' &&
      inherited.branch === 'docs/tesoreria',
    'Rama de trabajo: al apuntar a un repositorio se hereda su rama y sus metadatos',
    JSON.stringify(inherited)
  )

  // Se vuelve al repositorio de la prueba y se restaura la cabecera: lo que
  // sigue asume ese repositorio y ese módulo.
  await gui.fill('.topbar input[placeholder="Sin seleccionar"]', outDir)
  await gui.fill('.topbar input[placeholder="matriculas"]', 'matriculas')
  await gui.fill('.topbar input[placeholder="secretaria"]', 'secretaria')
  await gui.fill('.topbar input[placeholder="https://sistema.ejemplo.com"]', '')
  // Se compara por nombre de carpeta: el repositorio informa su ruta REAL
  // (`/private/var/...` en macOS), que no es literalmente la de `mkdtemp`.
  await gui.waitForFunction(
    (name) => document.querySelector('.status-repo')?.textContent === name,
    outDir.split('/').pop(),
    { timeout: 15000 }
  )

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

  // --- Redacción con IA ---
  const aiInitial = await gui.evaluate(() => window.docrecorder.invoke('ai:status'))
  check(
    aiInitial.settings.provider === 'anthropic' &&
      aiInitial.settings.models.anthropic === 'claude-opus-4-8' &&
      aiInitial.settings.models.gemini === 'gemini-3.5-flash' &&
      aiInitial.settings.useScreenshot === true &&
      aiInitial.ready === false,
    'IA: arranca con Claude por defecto, sin clave y sin estar lista',
    JSON.stringify(aiInitial.settings)
  )

  // Sin clave no se llama a nadie: se explica qué falta en vez de reventar.
  const aiNoKey = await gui.evaluate(() =>
    window.docrecorder.invoke('ai:draft', {
      meta: { module: 'm', feature: 'f', title: 't', role: 'r', baseUrl: 'http://x' },
      outline: [{ order: 1, title: 'Clic en «Guardar»' }],
      steps: [
        {
          id: 's1',
          order: 1,
          action: 'click',
          title: 'Clic en «Guardar»',
          description: '',
          url: 'http://x'
        }
      ]
    })
  )
  check(
    aiNoKey.drafts.length === 0 && /clave/i.test(aiNoKey.error ?? ''),
    'IA: sin clave configurada avisa en vez de fallar',
    aiNoKey.error
  )

  const FAKE_KEY = 'sk-ant-clave-de-prueba-12345'
  const aiWithKey = await gui.evaluate(
    (key) => window.docrecorder.invoke('ai:set-key', { provider: 'anthropic', key }),
    FAKE_KEY
  )
  check(
    aiWithKey.ready &&
      aiWithKey.configured.anthropic &&
      !JSON.stringify(aiWithKey).includes(FAKE_KEY),
    'IA: la clave se guarda y nunca vuelve al renderer'
  )

  // Un pegado equivocado en un campo enmascarado (un texto con emoji, no una
  // clave) se rechaza al guardarlo: si se guardara, la petición reventaría al
  // meterlo en la cabecera HTTP, con un error que no menciona la clave.
  const aiBadKey = await gui.evaluate(() =>
    window.docrecorder
      .invoke('ai:set-key', { provider: 'anthropic', key: 'no es una clave 🫠' })
      .then(
        () => null,
        (err) => String(err?.message ?? err)
      )
  )
  check(
    typeof aiBadKey === 'string' && /clave/i.test(aiBadKey),
    'IA: una clave con caracteres imposibles se rechaza al guardarla',
    aiBadKey
  )
  const aiStillOk = await gui.evaluate(() => window.docrecorder.invoke('ai:status'))
  check(
    aiStillOk.configured.anthropic === true,
    'IA: el rechazo no pisa la clave que ya estaba guardada'
  )

  const settingsRaw = readFileSync(join(userData, 'settings.json'), 'utf8')
  check(
    aiWithKey.encrypted ? !settingsRaw.includes(FAKE_KEY) : settingsRaw.includes('raw:'),
    'IA: la clave se guarda cifrada por el sistema operativo',
    aiWithKey.encrypted ? 'cifrada' : 'este sistema no ofrece cifrado'
  )

  // Cada proveedor guarda su propia clave: cambiar a Gemini no hereda la de Claude.
  const aiGemini = await gui.evaluate(() =>
    window.docrecorder.invoke('ai:set-settings', { provider: 'gemini' })
  )
  check(
    aiGemini.settings.provider === 'gemini' &&
      aiGemini.ready === false &&
      aiGemini.configured.anthropic === true,
    'IA: cada proveedor tiene su propia clave (Gemini sigue sin configurar)'
  )
  const aiBack = await gui.evaluate(() =>
    window.docrecorder.invoke('ai:set-settings', { provider: 'anthropic', useScreenshot: false })
  )
  check(
    aiBack.ready && aiBack.settings.useScreenshot === false,
    'IA: los ajustes (proveedor y envío de captura) se guardan'
  )

  // Los ajustes se abren desde la barra superior y releen el estado real: la
  // clave se guardó por IPC, sin pasar por la GUI, y aun así debe reflejarse.
  await gui.locator('.btn-ai-settings').click()
  await gui.waitForSelector('.ai-modal', { timeout: 5000 })
  await gui.waitForSelector('.ai-modal .ai-ok', { timeout: 5000 })
  check(
    (await gui.locator('.ai-modal .ai-ok').count()) > 0,
    'IA: los ajustes releen el estado y muestran la clave como configurada'
  )
  await gui.keyboard.press('Escape')
  await gui.waitForSelector('.ai-modal', { state: 'detached', timeout: 3000 })

  // Circuito completo en la GUI: se graban dos pasos nuevos y se redactan.
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('[data-testid="nueva-matricula"]')
  await waitSteps(1, 'ia: clic')
  // `select` emite su paso en cuanto cambia el valor; un `fill` suelto espera al
  // blur, y aquí no hay un campo siguiente que lo provoque.
  await target.selectOption('#curso', '2b')
  await waitSteps(2, 'ia: select')
  // Pausar evita que lleguen pasos nuevos mientras se comprueban los botones.
  await gui.locator('.panel-header .controls .ctrl').nth(1).click()

  const aiTitles = () =>
    gui.locator('.step-card .step-title').evaluateAll((els) => els.map((e) => e.value))
  const titlesBeforeOne = await aiTitles()
  await gui
    .locator('.step-card')
    .first()
    .getByRole('button', { name: /Redactar el paso 1/ })
    .click()
  await gui.waitForFunction(
    () => document.querySelector('.step-card .step-title')?.value?.startsWith('Redactado: '),
    null,
    { timeout: 15000 }
  )
  const titlesAfterOne = await aiTitles()
  const descAfterOne = await gui.locator('.step-card .step-desc').first().inputValue()
  check(
    titlesAfterOne[0] !== titlesBeforeOne[0] && descAfterOne.length > 0,
    'IA: el botón ✨ de un paso rellena su título y su descripción',
    `${titlesBeforeOne[0]} → ${titlesAfterOne[0]}`
  )
  check(
    titlesAfterOne[1] === titlesBeforeOne[1],
    'IA: redactar un paso no toca los demás',
    titlesAfterOne[1]
  )

  // --- Contexto pegado para la IA ---
  // La captura no dice cómo se llaman de verdad los campos ni qué valida cada
  // uno: eso se pega aquí y viaja con cada redacción. El proveedor simulado
  // arma el prompt de verdad, así que ver la marca en la descripción prueba que
  // el material llegó hasta él.
  await gui.getByRole('button', { name: /Contexto/ }).click()
  await gui.waitForSelector('.context-modal', { timeout: 5000 })
  const REFERENCE = 'Curso → Nombre (obligatorio), Paralelo (A|B), Cupo (número).'
  // Lo que se pega aquí son líneas largas (una fila de tabla, una consulta, una
  // URL sin espacios): el texto tiene que AJUSTARSE al ancho del campo, no
  // salirse de él. Se comprueba sobre el layout real, que es donde se veía.
  await gui
    .locator('.context-text')
    .fill(
      `SELECT id, nombre, paralelo, cupo FROM cursos WHERE periodo_id = 42 AND estado = 'ACTIVO' ORDER BY nombre ASC;\nhttps://sistema.ejemplo.com/administracion/cursos/listado?periodo=2026-1&estado=activo&orden=nombre`
    )
  const contextFit = await gui.evaluate(() => {
    const el = document.querySelector('.context-text')
    return {
      wrap: getComputedStyle(el).whiteSpace,
      overflow: el.scrollWidth - el.clientWidth
    }
  })
  check(
    contextFit.wrap === 'pre-wrap' && contextFit.overflow <= 1,
    'Contexto IA: el texto pegado se ajusta al ancho del campo y no se sale del borde',
    `${contextFit.wrap} · desborde ${contextFit.overflow}px`
  )
  await gui.locator('.context-text').fill(REFERENCE)
  await gui.getByRole('button', { name: /Guardar contexto/ }).click()
  await gui.waitForSelector('.context-modal', { state: 'detached', timeout: 3000 })
  check(
    (await gui.locator('.btn-context.set').count()) === 1,
    'Contexto IA: el panel marca que hay material de referencia puesto'
  )

  await gui
    .locator('.step-card')
    .first()
    .getByRole('button', { name: /Redactar el paso 1/ })
    .click()
  await gui.waitForFunction(
    () =>
      document
        .querySelector('.step-card .step-desc')
        ?.value?.includes('Con material de referencia'),
    null,
    { timeout: 15000 }
  )
  const descWithContext = await gui.locator('.step-card .step-desc').first().inputValue()
  check(
    descWithContext.includes('Con material de referencia.'),
    'Contexto IA: el material pegado llega al prompt de la redacción',
    descWithContext
  )

  // Sobrevive a cerrar la app: viaja en el borrador, como el resto de la sesión.
  await gui.waitForTimeout(1200)
  const draftWithContext = await gui.evaluate(() => window.docrecorder.invoke('draft:load'))
  check(
    draftWithContext?.meta?.aiContext === REFERENCE,
    'Contexto IA: se autoguarda con el borrador',
    draftWithContext?.meta?.aiContext ?? '(sin contexto)'
  )

  // «Redactar todos» solo debe tocar los pasos que van al manual: pagar tokens
  // por un paso excluido de la documentación no tendría sentido.
  await gui.locator('.step-card').nth(1).locator('.include-toggle input').uncheck()
  const titlesBeforeAll = await aiTitles()
  await gui.getByRole('button', { name: /Redactar todos/ }).click()
  await gui.waitForFunction(
    (before) => document.querySelectorAll('.step-card .step-title')[0]?.value !== before[0],
    titlesBeforeAll,
    { timeout: 15000 }
  )
  const titlesAfterAll = await aiTitles()
  check(
    titlesAfterAll[0].startsWith('Redactado: ') && titlesAfterAll[1] === titlesBeforeAll[1],
    'IA: «Redactar todos» omite los pasos excluidos de la documentación',
    `incluido: ${titlesAfterAll[0]} | excluido: ${titlesAfterAll[1]}`
  )

  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))
  // Estos pasos solo servían para probar la IA: se descartan para que el
  // autoguardado no siga escribiendo el borrador durante el desmontaje.
  await gui.evaluate(() => window.docrecorder.invoke('draft:clear'))

  // --- Agrupar campos: la captura resalta TODOS los campos del grupo ---
  // Un paso agrupado documenta varios campos a la vez. Si su captura marcase
  // solo el último, el manual señalaría un campo y describiría cinco: por eso,
  // al fundir, se pide al motor una captura nueva con todo el grupo resaltado.
  if (!(await gui.locator('.group-toggle input').isChecked())) {
    await gui.locator('.group-toggle input').check()
  }
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  const beforeGroup = await stepCount()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  // Referencia: el mismo botón sin nada encima, para saber cuánto brillo tenía
  // antes de que el modal lo oscureciera.
  const shotBeforeModal = decodePng(await target.screenshot({ type: 'png' }))
  await target.click('[data-testid="nueva-matricula"]')
  await waitSteps(beforeGroup + 1, 'grupo: abrir el modal')

  // --- Elemento tapado por el fondo de un modal ---
  // Al pulsar un botón que abre un modal, la captura se toma cuando el modal ya
  // está: su fondo translúcido oscurece justo el botón que el paso señala. Se le
  // devuelve el brillo dentro del recuadro. Se comprueba sobre los píxeles del
  // PNG, que es lo único que demuestra que se ve.
  // El último paso es el clic que acaba de abrir el modal con fondo oscuro.
  await gui.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('.step-card')]
      const img = cards[cards.length - 1]?.querySelector('.thumb img')
      return !!img && img.complete && img.naturalWidth > 0
    },
    null,
    { timeout: 20000 }
  )
  const modalStepShot = await gui.evaluate(() => {
    const cards = [...document.querySelectorAll('.step-card')]
    return cards[cards.length - 1]?.querySelector('.thumb img')?.src ?? null
  })
  const dimCheck = (() => {
    // `docshot://shot/<ruta>` → ruta absoluta del PNG en disco.
    const file = decodeURIComponent(new URL(modalStepShot).pathname.replace(/^\//, ''))
    const shot = decodePng(readFileSync(file))

    // El recuadro se localiza por su color (#FF5722): sin coordenadas fijas.
    let minX = Infinity
    let minY = Infinity
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < shot.height; y++) {
      for (let x = 0; x < shot.width; x++) {
        const i = (y * shot.width + x) * shot.channels
        const d = shot.data
        if (
          Math.abs(d[i] - 255) < 30 &&
          Math.abs(d[i + 1] - 87) < 30 &&
          Math.abs(d[i + 2] - 34) < 30
        ) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) return { found: false }

    const luminance = (png, x0, y0, x1, y1) => {
      let sum = 0
      let n = 0
      for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
          const i = (y * png.width + x) * png.channels
          sum += 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]
          n++
        }
      }
      return n ? sum / n : 0
    }

    // Misma zona en las dos capturas: el botón antes del modal y después.
    const box = [minX + 6, minY + 6, maxX - 5, maxY - 5]
    return {
      found: true,
      before: luminance(shotBeforeModal, ...box),
      after: luminance(shot, ...box)
    }
  })()

  // Sin compensar, el fondo del modal (negro al 40 %) deja el botón en torno al
  // 60 % de su brillo. Se exige que conserve al menos el 85 %: la diferencia
  // entre verlo y no verlo.
  check(
    dimCheck.found && dimCheck.after > dimCheck.before * 0.85,
    'Captura: el elemento señalado no queda apagado bajo el fondo del modal',
    dimCheck.found
      ? `brillo ${Math.round(dimCheck.before)} antes del modal → ${Math.round(dimCheck.after)} en la captura`
      : 'no se encontró el recuadro'
  )

  await target.fill('#alumno', 'Ana Pérez')
  await target.fill('#clave', 'secreto123')
  await target.selectOption('#curso', '2b')

  // Un interruptor estilizado: el <input> real está escondido y el widget
  // reenvía el clic. Debe dar UN paso, no dos, y unirse al mismo formulario en
  // vez de romperlo (era lo que pasaba al documentar el sistema real).
  await target.click('.switch-text')
  await gui.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('.step-card')]
      const labels = [...(cards[cards.length - 1]?.querySelectorAll('.field-label') ?? [])]
      return labels.some((l) => /Matrícula activa/.test(l.textContent ?? ''))
    },
    null,
    { timeout: 20000 }
  )
  // Margen para que un segundo paso indebido llegase a aparecer.
  await new Promise((r) => setTimeout(r, 1500))
  check(
    (await stepCount()) === beforeGroup + 2,
    'Agrupar campos: un interruptor se une al formulario y no genera dos pasos',
    `${beforeGroup} → ${await stepCount()}`
  )

  // Los tres campos y el interruptor deben quedar en UN paso.
  const groupedFields = await gui.evaluate(() => {
    const cards = [...document.querySelectorAll('.step-card')]
    return [...(cards[cards.length - 1]?.querySelectorAll('.field-label') ?? [])].map((l) =>
      l.textContent.replace(/:$/, '')
    )
  })
  check(
    groupedFields.length === 4 && groupedFields.includes('Matrícula activa'),
    'Agrupar campos: los tres campos y el interruptor se funden en un solo paso',
    groupedFields.join(' · ')
  )

  // La captura del grupo la genera el motor aparte (`group-*.png`); mientras no
  // llega se conserva la del último campo, así que se espera a que la sustituya.
  // Se espera también a que la miniatura esté decodificada: cambiar el `src` es
  // inmediato, pero el PNG nuevo tarda un instante en cargarse.
  await gui.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('.step-card')]
      const img = cards[cards.length - 1]?.querySelector('.thumb img')
      if (!img || !decodeURIComponent(img.src).includes('group-')) return false
      return img.complete && img.naturalWidth > 0
    },
    null,
    { timeout: 20000 }
  )
  const groupShotOk = await gui.evaluate(() => {
    const cards = [...document.querySelectorAll('.step-card')]
    const img = cards[cards.length - 1]?.querySelector('.thumb img')
    return {
      src: decodeURIComponent(img?.src ?? ''),
      loaded: !!img?.complete && img.naturalWidth > 0
    }
  })
  check(
    /group-.*\.png/.test(groupShotOk.src) && groupShotOk.loaded,
    'Agrupar campos: la captura se rehace marcando todo el grupo',
    groupShotOk.src.split('/').pop()
  )

  // Pulsar ■ sin los metadatos rellenos debe DETENER igualmente y explicar qué
  // falta. Antes solo avisaba y la grabación seguía viva: el botón parecía no
  // responder y no había forma de terminar sin completar la barra superior.
  // Se llega aquí grabando (viene de la etapa anterior), que es justo el caso.
  const moduleInput = gui.locator('.topbar input[placeholder="matriculas"]')
  const savedModule = await moduleInput.inputValue()
  await moduleInput.fill('')
  await gui.locator('.panel-header .controls .ctrl').nth(2).click()
  await gui.waitForSelector('.dialog', { timeout: 5000 })
  const stopWarning = await gui.locator('.dialog p').textContent()
  const statusAfterStop = await gui.locator('.status').textContent()
  await gui.getByRole('button', { name: 'Entendido' }).click()
  check(
    /falta indicar/i.test(stopWarning ?? '') &&
      /módulo/.test(stopWarning ?? '') &&
      statusAfterStop.includes('Listo'),
    'Detener: sin metadatos se detiene igualmente y avisa de lo que falta',
    `estado: ${statusAfterStop?.trim()}`
  )
  await moduleInput.fill(savedModule)

  // Quitar un campo del grupo debe llevarse también su acción del `flow.json`:
  // si no, el runner reproduciría un campo que el manual ya no documenta.
  const groupedCard = gui.locator('.step-card').last()
  const removedLabel = await groupedCard
    .locator('.field-list li .field-label')
    .first()
    .textContent()
  await groupedCard.locator('.field-list li .field-remove').first().click({ force: true })
  await gui.waitForFunction(
    (expected) => {
      const cards = [...document.querySelectorAll('.step-card')]
      return (cards[cards.length - 1]?.querySelectorAll('.field-list li').length ?? 0) === expected
    },
    groupedFields.length - 1,
    { timeout: 5000 }
  )
  const remaining = await groupedCard
    .locator('.field-list li .field-label')
    .evaluateAll((els) => els.map((e) => e.textContent))
  check(
    remaining.length === groupedFields.length - 1 && !remaining.includes(removedLabel),
    'Agrupar campos: se puede quitar un campo suelto del grupo',
    `quitado ${removedLabel} · quedan ${remaining.join(' ')}`
  )

  // --- Tabla: qué se funde y qué no dentro de una rejilla ---
  //
  // Los tres ámbitos que sí significan algo en un manual: la misma COLUMNA en
  // varias filas (la misma acción repetida sobre varios registros), la misma
  // FILA (un registro que se edita en línea) y nada más: dos controles distintos
  // de filas distintas no tienen que ver entre sí.
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  if (!(await gui.locator('.group-toggle input').isChecked())) {
    await gui.locator('.group-toggle input').check()
  }
  const beforeTable = await stepCount()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  // Misma columna, dos filas: marcar la casilla de dos registros es UN paso.
  await target.click('#sel-andy')
  await waitSteps(beforeTable + 1, 'tabla: primera fila')
  await target.click('#sel-paulo')
  await settle(() =>
    /filas/.test([...document.querySelectorAll('.step-card .step-title')].pop()?.value ?? '')
  )
  const column = await gui.evaluate(() => {
    const card = [...document.querySelectorAll('.step-card')].pop()
    return {
      total: document.querySelectorAll('.step-card').length,
      title: card.querySelector('.step-title')?.value ?? '',
      items: [...card.querySelectorAll('.field-label')].map((l) => l.textContent.replace(/:$/, ''))
    }
  })
  check(
    column.total === beforeTable + 1 && /2 filas/.test(column.title) && column.items.length === 2,
    'Tabla: la misma columna en dos filas se funde en un paso',
    `${column.title} · ${column.items.join(' · ')}`
  )

  // Otra columna de otra fila NO entra en ese grupo: no es la misma acción ni el
  // mismo registro.
  await target.selectOption('#estado-andy', 'Retirado')
  await waitSteps(beforeTable + 2, 'tabla: otra columna')
  check(
    (await stepCount()) === beforeTable + 2,
    'Tabla: un control de otra columna y otra fila no entra en el grupo de columna'
  )
  // Pero la MISMA columna sí, y el encabezado da el título.
  await target.selectOption('#estado-paulo', 'Retirado')
  await settle(() =>
    /«Estado»/.test([...document.querySelectorAll('.step-card .step-title')].pop()?.value ?? '')
  )
  const stateColumn = await gui.evaluate(() => ({
    total: document.querySelectorAll('.step-card').length,
    title: [...document.querySelectorAll('.step-card .step-title')].pop()?.value ?? ''
  }))
  check(
    stateColumn.total === beforeTable + 2 && /«Estado»/.test(stateColumn.title),
    'Tabla: la columna se funde y el paso se titula con su encabezado',
    stateColumn.title
  )
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))

  // La misma FILA sí se funde entera, aunque sean controles distintos: es un
  // registro que se está editando en línea.
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  const beforeRow = await stepCount()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('#sel-andy')
  await waitSteps(beforeRow + 1, 'fila: casilla')
  await target.selectOption('#estado-andy', 'Retirado')
  await settle(() =>
    /fila/i.test([...document.querySelectorAll('.step-card .step-title')].pop()?.value ?? '')
  )
  const rowGroup = await gui.evaluate(() => {
    const card = [...document.querySelectorAll('.step-card')].pop()
    return {
      total: document.querySelectorAll('.step-card').length,
      title: card.querySelector('.step-title')?.value ?? '',
      items: [...card.querySelectorAll('.field-label')].map((l) => l.textContent.replace(/:$/, ''))
    }
  })
  check(
    rowGroup.total === beforeRow + 1 && /fila/i.test(rowGroup.title) && rowGroup.items.length === 2,
    'Tabla: los controles de una misma fila se funden en un paso',
    `${rowGroup.title} · ${rowGroup.items.join(' · ')}`
  )
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))

  // --- Pestañas y botones: cada familia se funde consigo misma ---
  //
  // Recorrer dos pestañas es un paso del manual, no dos. Y lo mismo dos botones
  // seguidos. Lo que NO debe pasar es que se mezclen entre sí ni con los campos:
  // ahí está el corte natural del flujo.
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  const beforeTabs = await stepCount()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('#tab-pagos')
  await waitSteps(beforeTabs + 1, 'pestañas: primera')
  await target.click('#tab-datos')
  await settle(() =>
    /pestañas/.test([...document.querySelectorAll('.step-card .step-title')].pop()?.value ?? '')
  )
  const tabs = await gui.evaluate(() => {
    const card = [...document.querySelectorAll('.step-card')].pop()
    return {
      total: document.querySelectorAll('.step-card').length,
      title: card.querySelector('.step-title')?.value ?? '',
      items: [...card.querySelectorAll('.field-label')].map((l) => l.textContent.replace(/:$/, '')),
      canUngroup: !!card.querySelector('.icon-btn[title^="Deshacer"]')
    }
  })
  check(
    tabs.total === beforeTabs + 1 && /pestañas «Pagos» y «Datos»/.test(tabs.title),
    'Pestañas: dos pestañas seguidas se funden en un paso con sus nombres',
    `${tabs.title} · ${tabs.total} tarjeta(s)`
  )
  check(
    tabs.canUngroup && tabs.items.length === 2,
    'Agrupar seguidos: una fusión automática también se puede deshacer',
    tabs.items.join(' · ')
  )

  // Un botón detrás de las pestañas NO entra: es otra familia.
  await target.click('[data-testid="nueva-matricula"]')
  await waitSteps(beforeTabs + 2, 'pestañas: botón detrás')
  check(
    (await stepCount()) === beforeTabs + 2,
    'Agrupar seguidos: al cambiar de tipo de control empieza un paso nuevo'
  )
  // Y dos botones seguidos sí, aunque uno sea el que cierra el modal.
  await target.click('[data-testid="cancelar"]')
  await settle(() =>
    /«Cancelar»/.test([...document.querySelectorAll('.step-card .step-title')].pop()?.value ?? '')
  )
  const buttons = await gui.evaluate(() => ({
    total: document.querySelectorAll('.step-card').length,
    title: [...document.querySelectorAll('.step-card .step-title')].pop()?.value ?? ''
  }))
  check(
    buttons.total === beforeTabs + 2 && /Pulsar «Nueva matrícula» y «Cancelar»/.test(buttons.title),
    'Botones: dos botones seguidos se funden y el paso los enumera',
    buttons.title
  )
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))

  // --- Agrupar a mano lo que el motor deja aparte ---
  // Tres fallos que aparecieron documentando el sistema real, los tres sobre la
  // MISMA captura del grupo:
  //  1. El botón que cierra un formulario es un paso aparte (un botón no es un
  //     campo), y al agruparlo a mano su recuadro no aparecía.
  //  2. Los campos re-renderizados dejaban de marcarse: el nodo que el observador
  //     recordaba ya no existía, aunque el campo siguiera en pantalla.
  //  3. Con un desplegable abierto encima, los campos tapados salían lavados: se
  //     les «devolvía el brillo» sobre un panel opaco y todo lo claro se iba a
  //     blanco puro.
  // `fromEnd` = 1 es la última tarjeta, 2 la anterior: la del grupo no siempre es
  // la última (tras pulsar el botón, su propia tarjeta va detrás).
  const groupShotOf = async (fromEnd) => {
    const src = await gui.evaluate((n) => {
      const cards = [...document.querySelectorAll('.step-card')]
      return cards[cards.length - n]?.querySelector('.thumb img')?.src ?? ''
    }, fromEnd)
    const file = decodeURIComponent(new URL(src).pathname.replace(/^\//, ''))
    return { file, png: decodePng(readFileSync(file)) }
  }
  const waitGroupShot = async (fromEnd, previousName) => {
    await gui.waitForFunction(
      ([n, before]) => {
        const cards = [...document.querySelectorAll('.step-card')]
        const img = cards[cards.length - n]?.querySelector('.thumb img')
        if (!img) return false
        const src = decodeURIComponent(img.src)
        return (
          src.includes('group-') && !src.includes(before) && img.complete && img.naturalWidth > 0
        )
      },
      [fromEnd, previousName],
      { timeout: 25000 }
    )
    return groupShotOf(fromEnd)
  }

  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  const beforeMixed = await stepCount()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('[data-testid="nueva-matricula"]')
  await waitSteps(beforeMixed + 1, 'mixto: abrir el modal')
  await target.fill('#alumno', 'Ana Pérez')
  await target.fill('#clave', 'secreto123')
  // El clic en «Aplicar cambios» cierra el campo anterior (focusout), da su propio
  // paso y, por el camino, reemplaza los nodos de los campos.
  await target.click('[data-testid="aplicar"]')
  await waitSteps(beforeMixed + 3, 'mixto: campos y botón')

  const fieldsOnly = await waitGroupShot(2, 'ninguna')
  const boxesFieldsOnly = countHighlightBoxes(fieldsOnly.png)
  check(
    boxesFieldsOnly === 2,
    'Grupo: la captura del formulario marca sus dos campos',
    `${boxesFieldsOnly} recuadro(s) en ${fieldsOnly.file.split('/').pop()}`
  )

  // --- Lo que tapa al elemento: velo, panel opaco o adorno sin fondo ---
  // Se llama al observador directamente para leer su clasificación: es la decisión
  // que dejaba «borrosos» los campos del grupo.
  const cover = await target.evaluate(() => {
    const api = window.__docrec
    const field = document.querySelector('#alumno')
    const measure = (background) => {
      let layer = null
      if (background) {
        layer = document.createElement('div')
        layer.style.cssText = `position:fixed;inset:0;z-index:99999;background:${background}`
        document.body.appendChild(layer)
      }
      const result = api.highlightGroup({ targets: [{ refs: [], fallback: field }] })
      api.clearHighlight()
      layer?.remove()
      return result
    }
    return {
      libre: measure(null),
      adorno: measure('transparent'),
      velo: measure('rgba(0,0,0,0.45)'),
      panel: measure('#ffffff')
    }
  })
  check(
    cover.libre.marked === 1 && cover.libre.dimmed === 0 && cover.libre.blocked === 0,
    'Resaltado: un elemento despejado se marca sin compensar nada',
    JSON.stringify(cover.libre)
  )
  check(
    cover.adorno.dimmed === 0 && cover.adorno.blocked === 0,
    'Resaltado: una capa SIN fondo (el borde decorativo de un campo) no cuenta como tapar',
    JSON.stringify(cover.adorno)
  )
  check(
    cover.velo.dimmed === 1 && cover.velo.blocked === 0,
    'Resaltado: bajo un velo translúcido sí se le devuelve el brillo',
    JSON.stringify(cover.velo)
  )
  check(
    cover.panel.dimmed === 0 && cover.panel.blocked === 1,
    'Resaltado: bajo un panel opaco (un desplegable abierto) no se aclara nada y se avisa',
    JSON.stringify(cover.panel)
  )

  // --- El botón se agrupa a mano con el formulario ---
  const mixedCards = gui.locator('.step-card')
  const mixedTotal = await mixedCards.count()
  await mixedCards
    .nth(mixedTotal - 2)
    .locator('.step-select')
    .check()
  await mixedCards
    .nth(mixedTotal - 1)
    .locator('.step-select')
    .check()
  await gui.locator('.panel-toolbar.selection .btn:has-text("Agrupar")').click()
  await gui.waitForFunction(
    (n) => document.querySelectorAll('.step-card').length === n - 1,
    mixedTotal,
    { timeout: 5000 }
  )
  const mixedTitle = await gui.evaluate(
    () => [...document.querySelectorAll('.step-title')].pop()?.value
  )
  check(
    mixedTitle === 'Rellenar el formulario y pulsar «Aplicar cambios»',
    'Grupo mixto: el formulario y el botón que lo cierra se leen como un solo paso',
    mixedTitle
  )
  const withButton = await waitGroupShot(1, fieldsOnly.file.split('/').pop())
  const boxesWithButton = countHighlightBoxes(withButton.png)
  check(
    boxesWithButton === boxesFieldsOnly + 1,
    'Grupo mixto: marca el botón Y los campos ya re-renderizados (localizados por selector)',
    `${boxesFieldsOnly} → ${boxesWithButton} recuadro(s)`
  )
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))

  // --- Una fila de la tabla con un botón de fuera ---
  // El otro caso real: la fila dice qué registro y el botón de la barra qué se
  // hace con él. Son dos pasos que documentan una sola cosa.
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  const beforeRowBtn = await stepCount()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('#sel-andy')
  await waitSteps(beforeRowBtn + 1, 'fila+botón: fila')
  await target.click('[aria-label="Exportar listado"]')
  await waitSteps(beforeRowBtn + 2, 'fila+botón: botón de la barra')
  const rowCards = gui.locator('.step-card')
  const rowTotal = await rowCards.count()
  await rowCards
    .nth(rowTotal - 2)
    .locator('.step-select')
    .check()
  await rowCards
    .nth(rowTotal - 1)
    .locator('.step-select')
    .check()
  await gui.locator('.panel-toolbar.selection .btn:has-text("Agrupar")').click()
  await gui.waitForFunction(
    (n) => document.querySelectorAll('.step-card').length === n - 1,
    rowTotal,
    { timeout: 5000 }
  )
  const rowBtnShot = await waitGroupShot(1, 'ninguna')
  const boxesRowBtn = countHighlightBoxes(rowBtnShot.png)
  check(
    boxesRowBtn === 2,
    'Grupo mixto: una fila de la tabla y un botón de fuera se marcan los dos',
    `${boxesRowBtn} recuadro(s)`
  )
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))

  // --- Menú que se abre en `pointerdown` y se desvanece al elegir ---
  // Dos fallos del mismo widget, el más común de las interfaces actuales:
  //  1. El botón que lo abre no recibía `click` (la capa de descarte se traga el
  //     `pointerup`), así que pulsarlo no generaba paso —o generaba uno inútil
  //     sobre `<body>`—.
  //  2. Al elegir una opción, el menú se desvanece antes de desmontarse: la
  //     captura definitiva lo pillaba medio borrado.
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  const beforeMenu = await stepCount()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('#ver')
  await waitSteps(beforeMenu + 1, 'menú: abrir')
  const menuOpenTitle = await gui.evaluate(
    () => [...document.querySelectorAll('.step-title')].pop()?.value
  )
  check(
    menuOpenTitle === 'Clic en «Ver»',
    'Menú: un botón que abre su menú en pointerdown genera su paso',
    menuOpenTitle
  )

  // Abrir el menú y elegir su opción son DOS botones seguidos: el mismo tipo de
  // control, así que se funden en un paso, que es como lo cuenta un manual.
  await target.click('#ver-editar')
  await settle(() =>
    /«Ver».*«Editar»/.test(
      [...document.querySelectorAll('.step-card .step-title')].pop()?.value ?? ''
    )
  )
  const menuGroup = await gui.evaluate(() => ({
    total: document.querySelectorAll('.step-card').length,
    title: [...document.querySelectorAll('.step-card .step-title')].pop()?.value ?? ''
  }))
  check(
    menuGroup.total === beforeMenu + 1 && /«Ver».*«Editar»/.test(menuGroup.title),
    'Menú: abrir el menú y elegir su opción se funden en un paso',
    `${menuGroup.title} · ${menuGroup.total} tarjeta(s)`
  )
  await gui.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('.step-card')]
      const img = cards[cards.length - 1]?.querySelector('.thumb img')
      return !!img && img.complete && img.naturalWidth > 0
    },
    null,
    { timeout: 20000 }
  )
  const menuShot = await gui.evaluate(() => {
    const cards = [...document.querySelectorAll('.step-card')]
    return cards[cards.length - 1]?.querySelector('.thumb img')?.src ?? null
  })
  const menuPng = decodePng(
    readFileSync(decodeURIComponent(new URL(menuShot).pathname.replace(/^\//, '')))
  )
  // El menú es un azul saturado y opaco; al desvanecerse sobre el fondo blanco
  // se aclara hasta dejar de serlo. Se cuenta «azul saturado» en vez de un color
  // exacto porque la captura pasa por la gestión de color de la pantalla y los
  // valores no salen literales (medido: #00A2FF llega como 72,160,248).
  let menuPixels = 0
  for (let i = 0; i < menuPng.data.length; i += menuPng.channels) {
    const d = menuPng.data
    if (d[i] < 140 && d[i + 1] > 110 && d[i + 1] < 210 && d[i + 2] > 200) menuPixels++
  }
  // Medido: ~50 000 con el menú legible, ~350 (solo bordes) con el menú
  // desvanecido, que es lo que se capturaba antes.
  check(
    menuPixels > 10000,
    'Menú: al elegir una opción, el paso conserva la captura con el menú legible',
    `${menuPixels} píxeles del menú`
  )
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))

  // --- Clic que navega al instante («cerrar sesión») ---
  // La captura se toma tras esperar estabilidad, así que para entonces la página
  // ya es otra y el elemento no existe: el paso ilustraba la pantalla siguiente
  // y sin recuadro. Debe quedarse con la captura previa al clic, que sí lo
  // muestra. Se comprueba que la imagen contiene el recuadro (#FF5722).
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  const beforeLogout = await stepCount()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('#logout')
  await waitSteps(beforeLogout + 1, 'cerrar sesión')
  await gui.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('.step-card')]
      const img = cards[cards.length - 1]?.querySelector('.thumb img')
      return !!img && img.complete && img.naturalWidth > 0
    },
    null,
    { timeout: 20000 }
  )
  const logoutShot = await gui.evaluate(() => {
    const cards = [...document.querySelectorAll('.step-card')]
    return cards[cards.length - 1]?.querySelector('.thumb img')?.src ?? null
  })
  const logoutPng = decodePng(
    readFileSync(decodeURIComponent(new URL(logoutShot).pathname.replace(/^\//, '')))
  )
  let highlightPixels = 0
  for (let i = 0; i < logoutPng.data.length; i += logoutPng.channels) {
    const d = logoutPng.data
    if (Math.abs(d[i] - 255) < 30 && Math.abs(d[i + 1] - 87) < 30 && Math.abs(d[i + 2] - 34) < 30) {
      highlightPixels++
    }
  }
  check(
    highlightPixels > 200,
    'Captura: un clic que navega al instante conserva el elemento señalado',
    `${highlightPixels} píxeles de resaltado`
  )
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))

  // --- Agrupar a mano, bloque de contenido y captura externa ---
  // Las tres formas de documentar lo que el motor no puede grabar por sí solo:
  // unir pasos que son UNO para quien lee, escribir contenido de Docusaurus y
  // meter una pantalla ajena al navegador.
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  const beforeExtras = await stepCount()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  // Dos controles de filas Y columnas distintas: el motor los deja como dos
  // pasos (no son la misma acción ni el mismo registro) y es justo lo que hay
  // que poder unir a mano cuando para el manual sí son un paso.
  await target.click('#sel-andy')
  await waitSteps(beforeExtras + 1, 'extras: fila 1')
  await target.selectOption('#estado-paulo', 'Retirado')
  await waitSteps(beforeExtras + 2, 'extras: fila 2')
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))

  // Selección no contigua: el botón se apaga y explica por qué.
  await gui.locator('.step-card').first().locator('.step-select').check()
  await gui.locator('.step-card').last().locator('.step-select').check()
  await gui.waitForSelector('.panel-toolbar.selection', { timeout: 5000 })
  const farApart = await gui.evaluate(() => ({
    disabled: document.querySelector('.panel-toolbar.selection .btn.primary')?.disabled,
    hint: document.querySelector('.selection-hint')?.textContent ?? ''
  }))
  check(
    farApart.disabled === true && /seguidos/i.test(farApart.hint),
    'Agrupar a mano: dos pasos separados no se agrupan y se explica el motivo',
    farApart.hint
  )
  await gui.locator('.panel-toolbar.selection .btn:has-text("Cancelar")').click()

  // Las dos últimas tarjetas SÍ son contiguas: se agrupan en una.
  const cardsBeforeGroup = await gui.locator('.step-card').count()
  await gui
    .locator('.step-card')
    .nth(cardsBeforeGroup - 2)
    .locator('.step-select')
    .check()
  await gui
    .locator('.step-card')
    .nth(cardsBeforeGroup - 1)
    .locator('.step-select')
    .check()
  await gui.locator('.panel-toolbar.selection .btn:has-text("Agrupar")').click()
  await gui.waitForFunction(
    (n) => document.querySelectorAll('.step-card').length === n - 1,
    cardsBeforeGroup,
    { timeout: 5000 }
  )
  const manualGroup = await gui.evaluate(() => {
    const card = [...document.querySelectorAll('.step-card')].pop()
    return [...card.querySelectorAll('.field-label')].map((l) => l.textContent.replace(/:$/, ''))
  })
  check(
    manualGroup.length === 2 &&
      manualGroup.some((i) => /Seleccionar Andy/.test(i)) &&
      manualGroup.some((i) => /Estado de Paulo/.test(i)),
    'Agrupar a mano: dos controles que el motor deja aparte se funden en un paso',
    manualGroup.join(' · ')
  )

  // Y se puede deshacer, recuperando los dos pasos con su captura.
  await gui.locator('.step-card').last().locator('.icon-btn[title^="Deshacer"]').click()
  await gui.waitForFunction(
    (n) => document.querySelectorAll('.step-card').length === n,
    cardsBeforeGroup,
    { timeout: 5000 }
  )
  const restored = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-card')].slice(-2).map((c) => ({
      title: c.querySelector('.step-title')?.value ?? '',
      shot: !!c.querySelector('.thumb img')?.getAttribute('src')
    }))
  )
  check(
    restored.length === 2 && restored.every((c) => c.shot && /(Seleccionar|Estado)/.test(c.title)),
    'Agrupar a mano: deshacer devuelve cada paso con su propia captura',
    restored.map((c) => c.title).join(' · ')
  )
  // Se vuelven a agrupar: así el paquete guardado más abajo lleva el grupo.
  await gui
    .locator('.step-card')
    .nth(cardsBeforeGroup - 2)
    .locator('.step-select')
    .check()
  await gui
    .locator('.step-card')
    .nth(cardsBeforeGroup - 1)
    .locator('.step-select')
    .check()
  await gui.locator('.panel-toolbar.selection .btn:has-text("Agrupar")').click()
  await gui.waitForFunction(
    (n) => document.querySelectorAll('.step-card').length === n - 1,
    cardsBeforeGroup,
    { timeout: 5000 }
  )

  // Bloque de contenido: se escribe sintaxis de Docusaurus y se previsualiza.
  await gui.locator('.add-menu > button').click()
  await gui.locator('.add-menu-list button:has-text("Bloque de contenido")').click()
  await gui.waitForSelector('.step-card.kind-content', { timeout: 5000 })
  const contentCard = gui.locator('.step-card.kind-content').last()
  await contentCard.locator('.step-title').fill('Estados de una matrícula')
  await contentCard
    .locator('.content-body')
    .fill(
      [
        '| Estado | Significado | Editable |',
        '| --- | --- | :---: |',
        '| Activa | La matrícula está vigente | Sí |',
        '| Anulada | Se dio de baja | No |',
        '',
        'Si el saldo es < 0 la matrícula no se activa.',
        '',
        '```sql title="consulta.sql"',
        'SELECT * FROM matriculas WHERE estado = 1;',
        '```',
        '',
        '<Tabs>',
        '  <TabItem value="admin" label="Administrador">',
        '  Puede anular la matrícula.',
        '  </TabItem>',
        '</Tabs>'
      ].join('\n')
    )
  await gui.waitForFunction(
    () => !!document.querySelector('.step-card.kind-content .content-preview table'),
    null,
    { timeout: 5000 }
  )
  const preview = await gui.evaluate(() => {
    const box = document.querySelector('.step-card.kind-content .content-preview')
    return {
      headers: [...box.querySelectorAll('th')].map((th) => th.textContent),
      rows: box.querySelectorAll('tbody tr').length,
      code: box.querySelector('.code-block code')?.textContent ?? '',
      codeTitle: box.querySelector('.code-title')?.textContent ?? '',
      tabs: box.querySelector('.mdx-tab-label')?.textContent ?? '',
      // El `<` suelto debe verse como texto, no interpretarse como etiqueta.
      escaped: box.textContent.includes('saldo es < 0')
    }
  })
  check(
    preview.headers.join('|') === 'Estado|Significado|Editable' && preview.rows === 2,
    'Contenido: una tabla Markdown se previsualiza como tabla',
    `${preview.headers.join(' · ')} (${preview.rows} filas)`
  )
  check(
    /SELECT \* FROM matriculas/.test(preview.code) && preview.codeTitle === 'consulta.sql',
    'Contenido: el bloque de código se previsualiza con su título',
    preview.codeTitle
  )
  check(
    preview.tabs === 'Administrador',
    'Contenido: las pestañas de Docusaurus se previsualizan con su etiqueta',
    preview.tabs
  )
  check(preview.escaped, 'Contenido: un «<» suelto se muestra como texto, no como etiqueta')

  // Captura externa: fuente simulada → recorte → paso.
  await gui.locator('.add-menu > button').click()
  await gui.locator('.add-menu-list button:has-text("Captura de pantalla")').click()
  await gui.waitForSelector('.capture-dialog', { timeout: 5000 })
  await gui.waitForSelector('.capture-source', { timeout: 10000 })
  const sourceName = await gui.locator('.capture-source .capture-name').first().textContent()
  check(
    sourceName === 'Pantalla de prueba',
    'Captura externa: el selector lista las pantallas disponibles',
    sourceName
  )
  await gui.locator('.capture-source').first().click()
  await gui.waitForSelector('.capture-canvas', { timeout: 10000 })
  // El lienzo existe desde el primer render, pero no tiene tamaño real hasta que
  // la imagen se ha cargado: arrastrar antes no seleccionaría nada.
  await gui.waitForFunction(
    () => (document.querySelector('.capture-canvas')?.width ?? 0) > 300,
    null,
    { timeout: 10000 }
  )
  const canvasBox = await gui.locator('.capture-canvas').boundingBox()
  await gui.mouse.move(canvasBox.x + canvasBox.width * 0.2, canvasBox.y + canvasBox.height * 0.2)
  await gui.mouse.down()
  await gui.mouse.move(canvasBox.x + canvasBox.width * 0.8, canvasBox.y + canvasBox.height * 0.8, {
    steps: 10
  })
  await gui.mouse.up()
  const sizeBefore = await gui.evaluate(() => {
    const c = document.querySelector('.capture-canvas')
    return { w: c.width, h: c.height }
  })
  await gui.locator('.capture-dialog .btn:has-text("Aplicar")').click()
  await gui.waitForFunction(
    (before) => document.querySelector('.capture-canvas')?.width < before,
    sizeBefore.w,
    { timeout: 5000 }
  )
  const sizeAfter = await gui.evaluate(() => {
    const c = document.querySelector('.capture-canvas')
    return { w: c.width, h: c.height }
  })
  check(
    sizeAfter.w < sizeBefore.w && sizeAfter.h < sizeBefore.h,
    'Captura externa: el recorte reduce la imagen antes de aceptarla',
    `${sizeBefore.w}×${sizeBefore.h} → ${sizeAfter.w}×${sizeAfter.h}`
  )
  await gui.locator('.capture-dialog .btn:has-text("Añadir como paso")').click()
  await gui.waitForSelector('.capture-dialog', { state: 'detached', timeout: 10000 })
  await gui.waitForSelector('.step-card.kind-capture', { timeout: 5000 })
  const captureCard = await gui.evaluate(() => {
    const card = document.querySelector('.step-card.kind-capture')
    return {
      title: card.querySelector('.step-title')?.value ?? '',
      chip: card.querySelector('.selector-chip')?.textContent ?? ''
    }
  })
  check(
    /Pantalla de prueba/.test(captureCard.title) && /ajena al visor/.test(captureCard.chip),
    'Captura externa: se añade como paso, sin selector y marcada como externa',
    captureCard.title
  )

  // --- Pegar del portapapeles (§15) ---
  //
  // El pegado se prueba por su camino real, el evento del teclado: se construye
  // un `ClipboardEvent` con lo que llevaría el portapapeles (una imagen, o una
  // tabla en HTML) y se lanza sobre el documento. Así la prueba no depende de lo
  // que tuviera copiado quien la ejecuta.
  const cardsBeforePaste = await gui.locator('.step-card').count()
  // Se hace activa la PRIMERA tarjeta: lo pegado debe caer justo detrás de ella,
  // no al final de la lista.
  await gui.locator('.step-card').first().locator('.step-badge').click()
  await gui.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#0a5522'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const data = new DataTransfer()
    data.items.add(new File([blob], 'pegada.png', { type: 'image/png' }))
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })
  await gui.waitForSelector('.step-card.kind-image', { timeout: 5000 })
  const pastedImage = await gui.evaluate(() => {
    const cards = [...document.querySelectorAll('.step-card')]
    const index = cards.findIndex((c) => c.classList.contains('kind-image'))
    const card = cards[index]
    return {
      index,
      total: cards.length,
      title: card.querySelector('.step-title')?.value ?? '',
      chip: card.querySelector('.selector-chip')?.textContent ?? '',
      shot: card.querySelector('.thumb img')?.getAttribute('src') ?? '',
      canAdjust: !!card.querySelector('.icon-btn[title^="Recortar"]')
    }
  })
  check(
    pastedImage.total === cardsBeforePaste + 1 &&
      /Imagen pegada/.test(pastedImage.title) &&
      /imagen pegada/.test(pastedImage.chip) &&
      pastedImage.shot.startsWith('docshot://'),
    'Pegar: una imagen del portapapeles se convierte en una tarjeta con su imagen',
    pastedImage.title
  )
  check(
    pastedImage.index === 1,
    'Pegar: la tarjeta se inserta detrás de la que estaba activa, no al final',
    `posición ${pastedImage.index + 1} de ${pastedImage.total}`
  )

  // La imagen pegada admite lo mismo que cualquier paso: aquí, una nota
  // destacada, que es la razón de que sea un paso y no un adjunto.
  const imageCard = gui.locator('.step-card.kind-image')
  await imageCard.locator('.step-title').fill('Plantilla de carga masiva')
  await imageCard.locator('.note-btn').click()
  await imageCard.locator('.note-editor .note-type-warning').click()
  await imageCard.locator('.note-title').fill('Ojo con el formato')
  await imageCard.locator('.note-body').fill('La plantilla **no** admite columnas añadidas.')
  await gui.waitForFunction(
    () =>
      /no/.test(
        document.querySelector('.step-card.kind-image .note-preview .admonition-content')
          ?.textContent ?? ''
      ),
    null,
    { timeout: 5000 }
  )
  check(
    await imageCard.locator('.note-preview.admonition-warning').count(),
    'Pegar: la tarjeta de imagen admite nota destacada con estilo de Docusaurus'
  )

  // Ajustar después: el ✂ de la tarjeta reabre el editor con SU imagen (sin pasar
  // por el selector de fuentes) y solo cambia la imagen, no lo ya redactado.
  await imageCard.locator('.icon-btn[title^="Recortar"]').click()
  await gui.waitForSelector('.capture-canvas', { timeout: 10000 })
  check(
    !(await gui.locator('.capture-source').count()),
    'Pegar: ajustar la imagen de una tarjeta entra directo al editor, sin selector de fuentes'
  )
  const adjustBox = await gui.locator('.capture-canvas').boundingBox()
  await gui.mouse.move(adjustBox.x + adjustBox.width * 0.25, adjustBox.y + adjustBox.height * 0.25)
  await gui.mouse.down()
  await gui.mouse.move(
    adjustBox.x + adjustBox.width * 0.75,
    adjustBox.y + adjustBox.height * 0.75,
    {
      steps: 10
    }
  )
  await gui.mouse.up()
  await gui.locator('.capture-dialog .btn:has-text("Aplicar")').click()
  await gui.locator('.capture-dialog .btn:has-text("Guardar la imagen")').click()
  await gui.waitForSelector('.capture-dialog', { state: 'detached', timeout: 10000 })
  const adjusted = await gui.evaluate((before) => {
    const card = document.querySelector('.step-card.kind-image')
    return {
      changed: (card.querySelector('.thumb img')?.getAttribute('src') ?? '') !== before,
      title: card.querySelector('.step-title')?.value ?? '',
      note: card.querySelector('.note-body')?.value ?? ''
    }
  }, pastedImage.shot)
  check(
    adjusted.changed &&
      adjusted.title === 'Plantilla de carga masiva' &&
      /columnas/.test(adjusted.note),
    'Pegar: recortar una tarjeta cambia su imagen y conserva título y nota',
    adjusted.title
  )

  // Pegar texto no es lo mismo que pegar una imagen: una tabla copiada del sistema
  // documentado se convierte en un bloque de contenido, ya en Markdown.
  const contentBefore = await gui.locator('.step-card.kind-content').count()
  await gui.evaluate(() => {
    const data = new DataTransfer()
    data.setData(
      'text/html',
      '<table><tr><th>Campo</th><th>Obligatorio</th></tr><tr><td>Cédula</td><td>Sí</td></tr></table>'
    )
    data.setData('text/plain', 'Campo Obligatorio Cédula Sí')
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })
  await gui.waitForFunction(
    (n) => document.querySelectorAll('.step-card.kind-content').length === n + 1,
    contentBefore,
    { timeout: 5000 }
  )
  const pastedTable = await gui.evaluate(() => {
    // El bloque pegado no es el último de la lista: se insertó junto a la tarjeta
    // activa, así que se busca por su contenido.
    const card = [...document.querySelectorAll('.step-card.kind-content')].find((c) =>
      (c.querySelector('.content-body')?.value ?? '').includes('| Campo |')
    )
    if (!card) return { body: '', headers: [] }
    return {
      body: card.querySelector('.content-body')?.value ?? '',
      headers: [...card.querySelectorAll('.content-preview th')].map((th) => th.textContent)
    }
  })
  check(
    /\| Campo \| Obligatorio \|/.test(pastedTable.body) &&
      pastedTable.headers.join('|') === 'Campo|Obligatorio',
    'Pegar: una tabla copiada se convierte en un bloque de contenido en Markdown',
    pastedTable.headers.join(' · ')
  )

  // Dentro de un campo de texto, pegar sigue siendo pegar texto: la tarjeta solo
  // se crea cuando el pegado no tiene otro destino.
  const cardsBeforeGuard = await gui.locator('.step-card').count()
  await gui.evaluate(async () => {
    const input = document.querySelector('.step-card .step-title')
    input.focus()
    const canvas = document.createElement('canvas')
    canvas.width = 20
    canvas.height = 20
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const data = new DataTransfer()
    data.items.add(new File([blob], 'no.png', { type: 'image/png' }))
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })
  await gui.waitForTimeout(500)
  check(
    (await gui.locator('.step-card').count()) === cardsBeforeGuard,
    'Pegar: dentro de un campo de texto no se crea ninguna tarjeta',
    `${cardsBeforeGuard} tarjetas antes y después`
  )

  // Y el mismo pegado por el botón, que no tiene evento y lee el portapapeles del
  // sistema desde el proceso principal (simulado con DOCRECORDER_CAPTURE_FAKE).
  const imagesBefore = await gui.locator('.step-card.kind-image').count()
  await gui.locator('.add-menu > button').click()
  await gui.locator('.add-menu-list button:has-text("Imagen del portapapeles")').click()
  await gui.waitForFunction(
    (n) => document.querySelectorAll('.step-card.kind-image').length === n + 1,
    imagesBefore,
    { timeout: 5000 }
  )
  check(true, 'Pegar: «+ Añadir → Imagen del portapapeles» lee el portapapeles del sistema')

  // --- Quitar la nota y el bloque de contenido de un paso ---
  //
  // ▦ y 📝 solo abren y cierran su editor: sin un «quitar» de verdad, lo escrito
  // por error se seguía publicando y la única salida era vaciar el texto a mano.
  // Se comprueba en la tarjeta y, más abajo, en el manual publicado.
  const removable = gui
    .locator('.step-card:not(.kind-content):not(.kind-image):not(.kind-capture)')
    .first()
  await removable.locator('.note-btn').click()
  await removable.locator('.note-body').fill('Nota que se va a quitar.')
  await removable.locator('.content-btn').click()
  await removable.locator('.content-body').fill('Bloque que se va a quitar.')
  await removable.locator('.note-btn.has-note').waitFor({ timeout: 5000 })
  await removable.locator('.content-btn.has-content').waitFor({ timeout: 5000 })
  check(true, 'Quitar: un paso admite a la vez nota y bloque de contenido')

  // Con texto escrito, el 🗑 pregunta antes: la confirmación es EN LÍNEA porque
  // el visor nativo taparía cualquier diálogo que no lance el panel.
  await removable.locator('.step-note .editor-remove').click()
  await removable.locator('.step-note .editor-remove-confirm button.danger').click()
  await removable.locator('.step-content .editor-remove').click()
  await removable.locator('.step-content .editor-remove-confirm button.danger').click()
  const cleaned = await gui.evaluate(() => {
    const card = document.querySelector(
      '.step-card:not(.kind-content):not(.kind-image):not(.kind-capture)'
    )
    return {
      note: !!card.querySelector('.note-editor'),
      content: !!card.querySelector('.content-editor'),
      marked: !!card.querySelector('.has-note, .has-content')
    }
  })
  check(
    !cleaned.note && !cleaned.content && !cleaned.marked,
    'Quitar: 🗑 quita la nota y el bloque, cierra su editor y apaga su marca en la cabecera',
    JSON.stringify(cleaned)
  )

  // Guardado: el MDX debe llevar tabla, código, pestañas (con sus imports), la
  // captura externa y las imágenes pegadas, y NO numerar el bloque de contenido
  // como un paso más.
  await gui.fill('.topbar input[placeholder="matriculas"]', 'matriculas')
  await gui.fill('.topbar input[placeholder="institucion"]', '')
  await gui.fill('.topbar input[placeholder="crear-matricula"]', 'extras-de-matricula')
  await gui.fill('.topbar input[placeholder="Crear una matrícula"]', 'Extras de matrícula')
  const gitBox = gui.locator('.git-section input[type="checkbox"]').first()
  if (await gitBox.isChecked()) await gitBox.uncheck()
  const includedBefore = await gui.evaluate(
    () =>
      [...document.querySelectorAll('.step-card')].filter(
        (c) => c.querySelector('.include-toggle input')?.checked
      ).length
  )
  const contentSteps = await gui.locator('.step-card.kind-content').count()
  await gui.locator('.panel-header .controls .ctrl').nth(2).click()
  await gui.waitForSelector('.dialog', { timeout: 10000 })
  if (await gui.getByRole('button', { name: 'Guardar de todos modos' }).count()) {
    await gui.getByRole('button', { name: 'Guardar de todos modos' }).click()
  }
  await gui.waitForFunction(
    () => /Documentación guardada/.test(document.querySelector('.dialog h3')?.textContent ?? ''),
    null,
    { timeout: 15000 }
  )
  await gui.getByRole('button', { name: 'Cerrar' }).click()

  // Al estrenar sesión con material de referencia puesto, la app PREGUNTA qué
  // hacer con él. Sin esto se arrastraba en silencio a la guía siguiente y la IA
  // redactaba con los nombres y las reglas de la anterior sin que se notara.
  await gui.waitForSelector('.dialog', { timeout: 5000 })
  const contextAsk = await gui.locator('.dialog h3').textContent()
  await gui.getByRole('button', { name: 'Vaciar el contexto' }).click()
  await gui.waitForSelector('.dialog', { state: 'detached', timeout: 5000 })
  check(
    /contexto para la IA/i.test(contextAsk ?? '') &&
      (await gui.locator('.btn-context.set').count()) === 0,
    'Contexto IA: al estrenar sesión se pregunta, y «Vaciar» lo quita de verdad',
    contextAsk ?? '(no se preguntó)'
  )

  const extrasDir = join(outDir, 'matriculas', 'extras-de-matricula')
  const extrasMdx = readFileSync(join(extrasDir, 'index.mdx'), 'utf8')
  const extrasSession = JSON.parse(readFileSync(join(extrasDir, 'session.json'), 'utf8'))
  const extrasFlow = JSON.parse(readFileSync(join(extrasDir, 'flow.json'), 'utf8'))

  check(
    !/se va a quitar/i.test(extrasMdx) && !JSON.stringify(extrasSession).includes('se va a quitar'),
    'Quitar: lo quitado no llega al manual ni al paquete'
  )
  check(
    /\| Estado \| Significado \| Editable \|/.test(extrasMdx) &&
      /\| Activa \| La matrícula está vigente \| Sí \|/.test(extrasMdx),
    'Contenido: la tabla se publica tal cual en el MDX'
  )
  check(
    /```sql title="consulta.sql"/.test(extrasMdx) &&
      /SELECT \* FROM matriculas WHERE estado = 1;/.test(extrasMdx),
    'Contenido: el bloque de código llega intacto al MDX (no se escapa por dentro)'
  )
  check(
    extrasMdx.includes("import Tabs from '@theme/Tabs';") &&
      extrasMdx.includes("import TabItem from '@theme/TabItem';") &&
      /<Tabs>/.test(extrasMdx),
    'Contenido: usar pestañas añade solo sus imports a la página'
  )
  check(
    /saldo es &lt; 0/.test(extrasMdx) && !/saldo es < 0/.test(extrasMdx),
    'Contenido: un «<» suelto se escapa en el MDX y no rompe el build'
  )
  const headings = (extrasMdx.match(/^## \d+\./gm) ?? []).length
  check(
    headings === includedBefore - contentSteps && /^### Estados de una matrícula$/m.test(extrasMdx),
    'Contenido: el bloque no consume número de paso y lleva un encabezado menor',
    `${headings} pasos numerados, ${contentSteps} bloque(s) de contenido`
  )

  // Un grupo cuyo título ya enumera sus elementos («Pulsar «Ver» y «Editar»») no
  // los repite debajo en una lista: sería decir dos veces lo mismo.
  const enumerated = extrasMdx.match(
    /^#{2,3} \d+\. (?:Pulsar|Ir a las pestañas) «([^»]+)» y «([^»]+)»/m
  )
  check(
    !!enumerated && !extrasMdx.includes(`- **${enumerated[1]}**`),
    'Agrupar seguidos: el manual no repite en una lista lo que el título ya enumera',
    enumerated?.[0] ?? '(sin grupo enumerado en el MDX)'
  )

  const captureStep = extrasSession.steps.find((s) => s.kind === 'capture')
  const contentStep = extrasSession.steps.find((s) => s.kind === 'content')
  check(
    !!captureStep && existsSync(join(extrasDir, captureStep.screenshot)),
    'Captura externa: su imagen se copia al paquete como una más',
    captureStep?.screenshot
  )
  check(
    !!contentStep && contentStep.screenshot === '' && !!contentStep.content,
    'Contenido: el paso se guarda con su cuerpo y sin imagen'
  )
  const imageSteps = extrasSession.steps.filter((s) => s.kind === 'image')
  check(
    imageSteps.length === 2 && imageSteps.every((s) => existsSync(join(extrasDir, s.screenshot))),
    'Pegar: las imágenes pegadas se guardan con su tipo propio y su archivo en el paquete',
    imageSteps.map((s) => s.screenshot).join(' · ')
  )
  check(
    /## \d+\. Plantilla de carga masiva/.test(extrasMdx) &&
      /:::warning\[Ojo con el formato\]/.test(extrasMdx),
    'Pegar: la imagen pegada se numera como paso y publica su nota en el MDX'
  )
  check(
    !extrasFlow.actions.some(
      (a) => a.action === 'capture' || a.action === 'content' || a.action === 'image'
    ),
    'Flujo: nada de lo añadido a mano (captura, imagen o contenido) entra en flow.json'
  )
  check(
    extrasSession.steps.some((s) => s.fields?.length === 2 && s.mergedActions?.length === 2),
    'Agrupar a mano: el paso agrupado se guarda con sus dos acciones para el runner'
  )

  // El runner salta lo que no sale del navegador en vez de darlo por fallido.
  const extrasRegen = await gui.evaluate(
    (dir) => window.docrecorder.invoke('runner:regenerate', dir),
    extrasDir
  )
  const skipped = extrasRegen.results.filter((r) => r.status === 'skipped')
  check(
    skipped.length === 5 && skipped.filter((r) => /Imagen pegada/.test(r.detail)).length === 2,
    'Runner: lo añadido a mano se salta (captura, imágenes pegadas y contenido), no cuenta como fallo',
    skipped.map((r) => r.detail).join(' | ')
  )
  if (await gui.locator('.runner-report').count()) {
    await gui.getByRole('button', { name: 'Entendido' }).click()
  }

  // --- Secciones: apartados dentro de una grabación (§8/§10) ---
  //
  // Una grabación real tiene treinta pasos y varias fases («preparación»,
  // «registro», «cierre»). Aquí se comprueba el circuito entero: crear el
  // apartado donde toca, plegarlo, moverlo CON sus pasos y publicarlo como
  // encabezado del manual.
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  // Aquí interesan cuatro pasos sueltos con los que probar los apartados, no la
  // fusión: cuatro clics seguidos del mismo tipo se fundirían en uno.
  if (await gui.locator('.group-toggle input').isChecked()) {
    await gui.locator('.group-toggle input').uncheck()
  }
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('#nav-alumnos')
  await waitSteps(1, 'secciones: paso A')
  await target.click('#nav-matriculas')
  await waitSteps(2, 'secciones: paso B')
  await target.click('#sel-andy')
  await waitSteps(3, 'secciones: paso C')
  await target.click('#sel-paulo')
  await waitSteps(4, 'secciones: paso D')
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))

  // Un paso GRABADO también entra detrás de la tarjeta activa: es lo que permite
  // volver a un punto del flujo y completar lo que faltaba, sin que aparezca al
  // final de la lista y haya que arrastrarlo hasta su sitio.
  await gui.locator('.step-card').first().locator('.step-badge').click()
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('#sel-todos')
  await waitSteps(5, 'secciones: paso intercalado')
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))
  const inserted = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-card .step-title')].map((i) => i.value)
  )
  check(
    /todo/i.test(inserted[1] ?? ''),
    'Secciones: un paso grabado entra detrás de la tarjeta activa, no al final',
    inserted.join(' | ')
  )
  await gui.locator('.group-toggle input').check()
  // Se quita para dejar los cuatro pasos de partida.
  await gui.locator('.step-card').nth(1).locator('.icon-btn[title="Eliminar paso"]').click()
  await gui.waitForFunction(() => document.querySelectorAll('.step-card').length === 4, null, {
    timeout: 5000
  })

  // La sección encabeza lo que viene detrás: se marca el paso anterior y se crea.
  await gui.locator('.step-card').nth(1).locator('.step-badge').click()
  await gui.locator('.add-menu > button').click()
  await gui.locator('.add-menu-list button:has-text("Sección")').click()
  await gui.waitForSelector('.section-card', { timeout: 5000 })
  await gui.locator('.section-card .section-title').fill('Registro del alumno')
  const sectionPlaced = await gui.evaluate(() => ({
    index: [...document.querySelectorAll('.step-card, .section-card')].findIndex((n) =>
      n.classList.contains('section-card')
    ),
    count: document.querySelector('.section-count')?.textContent ?? '',
    // El recuento del encabezado cuenta pasos, no secciones.
    header: document.querySelector('.panel-header .count')?.textContent ?? ''
  }))
  check(
    sectionPlaced.index === 2 && sectionPlaced.count === '2' && sectionPlaced.header === '4',
    'Secciones: se inserta tras la tarjeta activa y toma los pasos que siguen',
    `posición ${sectionPlaced.index}, ${sectionPlaced.count} paso(s), encabezado ${sectionPlaced.header}`
  )

  // Plegar oculta sus pasos (y solo los suyos), que es lo que hace manejable una
  // grabación larga.
  await gui.locator('.section-card .section-toggle').click()
  await gui.waitForFunction(() => document.querySelectorAll('.step-card').length === 2, null, {
    timeout: 5000
  })
  check(true, 'Secciones: plegar oculta los pasos de esa sección y deja los demás')
  await gui.locator('.section-card .section-toggle').click()
  await gui.waitForFunction(() => document.querySelectorAll('.step-card').length === 4, null, {
    timeout: 5000
  })

  // Arrastrar la sección la mueve CON sus pasos: subirla una posición debe
  // llevarse los dos que cuelgan de ella y dejar detrás al que la precedía.
  const titlesBeforeMove = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-card, .section-card')].map((n) =>
      n.classList.contains('section-card')
        ? `§${n.querySelector('.section-title').value}`
        : n.querySelector('.step-title').value
    )
  )
  await gui.locator('.section-card').scrollIntoViewIfNeeded()
  const secHandle = await gui.locator('.section-card .drag-handle').boundingBox()
  const aboveCard = await gui.locator('.step-card').nth(1).boundingBox()
  await gui.mouse.move(secHandle.x + secHandle.width / 2, secHandle.y + secHandle.height / 2)
  await gui.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await gui.mouse.move(
      secHandle.x + secHandle.width / 2,
      secHandle.y + secHandle.height / 2 - (aboveCard.height * i) / 12
    )
    await new Promise((r) => setTimeout(r, 25))
  }
  await gui.mouse.up()
  await new Promise((r) => setTimeout(r, 600))
  const titlesAfterMove = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-card, .section-card')].map((n) =>
      n.classList.contains('section-card')
        ? `§${n.querySelector('.section-title').value}`
        : n.querySelector('.step-title').value
    )
  )
  check(
    titlesAfterMove[1]?.startsWith('§') &&
      titlesAfterMove[2] === titlesBeforeMove[3] &&
      titlesAfterMove[3] === titlesBeforeMove[4] &&
      titlesAfterMove[4] === titlesBeforeMove[1],
    'Secciones: arrastrar la sección se lleva sus pasos con ella',
    `antes=[${titlesBeforeMove.join(' | ')}] después=[${titlesAfterMove.join(' | ')}]`
  )

  // Guardado: la sección encabeza el apartado y los pasos bajan un nivel, con la
  // numeración corrida entre apartados.
  await gui.fill('.topbar input[placeholder="matriculas"]', 'matriculas')
  await gui.fill('.topbar input[placeholder="institucion"]', '')
  await gui.fill('.topbar input[placeholder="crear-matricula"]', 'con-secciones')
  await gui.fill('.topbar input[placeholder="Crear una matrícula"]', 'Matrícula por apartados')
  await gui.locator('.panel-header .controls .ctrl').nth(2).click()
  await gui.waitForSelector('.dialog', { timeout: 10000 })
  if (await gui.getByRole('button', { name: 'Guardar de todos modos' }).count()) {
    await gui.getByRole('button', { name: 'Guardar de todos modos' }).click()
  }
  await gui.waitForFunction(
    () => /Documentación guardada/.test(document.querySelector('.dialog h3')?.textContent ?? ''),
    null,
    { timeout: 15000 }
  )
  await gui.getByRole('button', { name: 'Cerrar' }).click()

  const sectionsDir = join(outDir, 'matriculas', 'con-secciones')
  const sectionsMdx = readFileSync(join(sectionsDir, 'index.mdx'), 'utf8')
  const sectionsSession = JSON.parse(readFileSync(join(sectionsDir, 'session.json'), 'utf8'))
  const sectionsFlow = JSON.parse(readFileSync(join(sectionsDir, 'flow.json'), 'utf8'))
  check(
    /^## Registro del alumno$/m.test(sectionsMdx) &&
      (sectionsMdx.match(/^### \d+\./gm) ?? []).length === 4 &&
      !/^## \d+\./m.test(sectionsMdx),
    'Secciones: el apartado sale como ## y los pasos bajan a ###',
    (sectionsMdx.match(/^#{2,3} .*/gm) ?? []).join(' / ')
  )
  check(
    sectionsMdx.indexOf('### 1.') < sectionsMdx.indexOf('## Registro del alumno') &&
      sectionsMdx.indexOf('## Registro del alumno') < sectionsMdx.indexOf('### 2.'),
    'Secciones: la numeración de los pasos sigue corrida entre apartados'
  )
  const sectionStep = sectionsSession.steps.find((s) => s.kind === 'section')
  check(
    !!sectionStep && sectionStep.screenshot === '',
    'Secciones: el separador se guarda como paso sin captura',
    sectionStep?.title
  )
  check(
    !sectionsFlow.actions.some((a) => a.action === 'section'),
    'Secciones: el separador no entra en flow.json (no hay nada que reproducir)'
  )

  // --- Descartar documentación que Git no tiene registrada ---
  //
  // La otra salida de «⚠ N sin registrar»: no todo lo que quedó fuera del
  // historial merece entrar en él. El paquete recién guardado (sin Git) es justo
  // ese caso.
  await gui.locator('.status-link.warn').click()
  await gui.waitForSelector('.pending-modal', { timeout: 5000 })
  const pendingRow = gui.locator('.pending-list > li', {
    has: gui.locator('code.pending-path', { hasText: 'matriculas/con-secciones' })
  })
  // La lista se lee del repositorio al abrir: hay que esperarla, no contarla.
  await pendingRow.waitFor({ timeout: 10000 })
  check(
    (await pendingRow.count()) === 1,
    'Descartar: el paquete guardado sin commitear aparece en la lista de sin registrar'
  )
  await pendingRow.locator('.btn.danger').click()
  await gui.waitForSelector('.dialog', { timeout: 5000 })
  const discardBody = await gui.locator('.dialog p').innerText()
  check(
    /papelera/i.test(discardBody) && /con-secciones/.test(discardBody),
    'Descartar: se avisa exactamente de qué va a pasar antes de tocar nada',
    discardBody.split('\n')[2] ?? discardBody
  )
  await gui.locator('.dialog .btn.danger').click()
  await gui.waitForFunction(() => !!document.querySelector('.pending-modal .ai-saved'), null, {
    timeout: 10000
  })
  check(
    !existsSync(sectionsDir),
    'Descartar: la carpeta del paquete sale del disco (a la papelera del sistema)'
  )
  await gui.locator('.pending-modal footer .btn').click()
  await gui.waitForSelector('.pending-modal', { state: 'detached', timeout: 5000 })

  // Y el otro caso: un paquete que SÍ está commiteado y se ha tocado después.
  // Ahí no hay nada que tirar, se devuelve a su versión del último commit.
  const headSession = g('ls-tree -r --name-only HEAD')
    .split('\n')
    .find((p) => p.endsWith('session.json'))
  const headDir = headSession.replace(/\/session\.json$/, '')
  const headMdx = join(outDir, headDir, 'index.mdx')
  const originalMdx = readFileSync(headMdx, 'utf8')
  writeFileSync(headMdx, `${originalMdx}\n<!-- retoque a mano que no se quiso -->\n`)
  const dirtyPending = await gui.evaluate(
    (root) => window.docrecorder.invoke('git:pending-docs', root),
    outDir
  )
  check(
    dirtyPending.some((d) => d.dir === headDir && d.untracked === false),
    'Descartar: un paquete ya commiteado y modificado se lista como «cambiado»',
    headDir
  )
  const restoreResult = await gui.evaluate(
    ([root, dir]) => window.docrecorder.invoke('git:discard-pending', { repoRoot: root, dir }),
    [outDir, headDir]
  )
  check(
    restoreResult.restored > 0 && readFileSync(headMdx, 'utf8') === originalMdx,
    'Descartar: lo ya commiteado vuelve a su versión del commit, sin borrarse',
    restoreResult.message
  )

  // --- Volver a editar una funcionalidad ya commiteada ---
  //
  // Revisar un commit suele acabar en «esto hay que corregirlo». Se recorre el
  // camino real: explorador → rama → commit → vista previa → editar, y los pasos
  // deben aparecer en el panel con sus capturas, listos para volver a guardarse
  // en la misma carpeta y la misma rama.
  await gui.getByRole('button', { name: 'Proyectos…', exact: true }).click()
  await gui.waitForSelector('.projects-modal', { timeout: 5000 })
  await gui.locator('.projects-col:nth-child(2) .row[data-branch="docs/matriculas"]').click()
  await gui.waitForSelector('.projects-col:nth-child(3) .commits li', { timeout: 5000 })
  // El historial muestra el hash abreviado; se busca el que es prefijo del
  // commit que documentó «crear-matricula» (y se dice cuál hay, si no aparece).
  const uiHashes = await gui.locator('.projects-col:nth-child(3) .commits code').allInnerTexts()
  const wanted = uiHashes.findIndex((h) => firstCommit.startsWith(h.trim()))
  const historyOf = await gui.locator('.projects-col:nth-child(3) h3').innerText()
  check(
    wanted >= 0,
    'Editar un commit: el commit que documentó la funcionalidad está en el historial',
    `busco ${firstCommit.slice(0, 8)} en «${historyOf}» entre [${uiHashes.join(' ')}]`
  )
  await gui.locator('.projects-col:nth-child(3) .commits li .row').nth(Math.max(wanted, 0)).click()
  await gui.waitForSelector('.preview-modal', { timeout: 5000 })
  await gui.waitForSelector('.preview-feature-head .btn', { timeout: 5000 })
  await gui.locator('.preview-feature-head .btn').first().click()
  // La sesión está vacía (se acaba de guardar), así que no debería preguntar; si
  // preguntara, se confirma.
  if (await gui.locator('.dialog .btn.danger').count()) {
    await gui.locator('.dialog .btn.danger').click()
  }
  await gui.waitForSelector('.projects-modal', { state: 'detached', timeout: 10000 })
  await gui.waitForFunction(() => document.querySelectorAll('.step-card').length > 0, null, {
    timeout: 10000
  })
  const reopened = await gui.evaluate(() => ({
    steps: document.querySelectorAll('.step-card').length,
    withShot: [...document.querySelectorAll('.step-card')].filter((c) =>
      c.querySelector('.thumb img')?.getAttribute('src')?.startsWith('docshot://')
    ).length,
    feature: document.querySelector('.topbar input[placeholder="crear-matricula"]')?.value ?? '',
    branch: document.querySelector('.branch-chip code')?.textContent ?? ''
  }))
  check(
    reopened.steps > 0 && reopened.withShot === reopened.steps,
    'Editar un commit: los pasos vuelven al panel con su captura ya cargada',
    `${reopened.withShot}/${reopened.steps} con captura`
  )
  check(
    reopened.feature === 'crear-matricula' && reopened.branch === 'docs/matriculas',
    'Editar un commit: se recuperan sus metadatos y su rama de trabajo',
    `${reopened.feature} · ${reopened.branch}`
  )
  // La franja dice qué se está editando y ofrece la salida: cancelar sin
  // registrar nada. Es lo que faltaba: con el panel lleno de pasos que nadie ha
  // grabado aquí, la única salida visible era ■, que guarda y comitea.
  const strip = await gui.evaluate(() => {
    const el = document.querySelector('.editing-strip')
    return el ? { text: el.innerText, hasExit: !!el.querySelector('.btn') } : null
  })
  check(
    !!strip && strip.hasExit && /crear-matricula|Crear una matr/i.test(strip.text),
    'Editar un commit: el panel dice qué se está editando y ofrece descartarlo',
    strip?.text.replace(/\n/g, ' · ') ?? '(sin franja)'
  )
  // Descartar vacía el panel sin tocar el repositorio.
  const commitsBeforeDiscard = Number(g('rev-list --count docs/matriculas'))
  // El árbol ya trae paquetes sin registrar de las etapas anteriores: lo que hay
  // que comprobar es que descartar no CAMBIA nada, no que esté limpio.
  const treeBeforeDiscard = g('status --porcelain')
  await gui.locator('.editing-strip .btn').click()
  await gui.waitForSelector('.dialog', { timeout: 5000 })
  await gui.locator('.dialog .btn.danger').click()
  await gui.waitForFunction(() => document.querySelectorAll('.step-card').length === 0, null, {
    timeout: 5000
  })
  check(
    !(await gui.locator('.editing-strip').count()) &&
      Number(g('rev-list --count docs/matriculas')) === commitsBeforeDiscard &&
      g('status --porcelain') === treeBeforeDiscard,
    'Editar un commit: descartar vacía el panel y no registra ni escribe nada',
    `${commitsBeforeDiscard} commit(s), árbol ${
      g('status --porcelain') === treeBeforeDiscard ? 'igual que antes' : 'cambiado'
    }`
  )

  // Se vuelve a cargar para comprobar lo otro: que guardar sí reescribe SU
  // carpeta (no crea una nueva) y apila un commit encima.
  await gui.getByRole('button', { name: 'Proyectos…', exact: true }).click()
  await gui.waitForSelector('.projects-modal', { timeout: 5000 })
  await gui.locator('.projects-col:nth-child(2) .row[data-branch="docs/matriculas"]').click()
  await gui.waitForSelector('.projects-col:nth-child(3) .commits li', { timeout: 5000 })
  await gui.locator('.projects-col:nth-child(3) .commits li .row').nth(Math.max(wanted, 0)).click()
  await gui.waitForSelector('.preview-feature-head .btn', { timeout: 5000 })
  await gui.locator('.preview-feature-head .btn').first().click()
  if (await gui.locator('.dialog .btn.danger').count()) {
    await gui.locator('.dialog .btn.danger').click()
  }
  await gui.waitForSelector('.projects-modal', { state: 'detached', timeout: 10000 })
  await gui.waitForFunction(() => document.querySelectorAll('.step-card').length > 0, null, {
    timeout: 10000
  })

  const reeditCard = gui.locator('.step-card').first()
  await reeditCard.locator('.step-title').fill('Paso corregido tras revisar el commit')
  const commitsBefore = Number(g('rev-list --count docs/matriculas'))
  await gui.locator('.panel-header .controls .ctrl').nth(2).click()
  await gui.waitForSelector('.dialog', { timeout: 10000 })
  if (await gui.getByRole('button', { name: 'Registrar en Git' }).count()) {
    await gui.getByRole('button', { name: 'Registrar en Git' }).click()
  }
  if (await gui.getByRole('button', { name: 'Guardar de todos modos' }).count()) {
    await gui.getByRole('button', { name: 'Guardar de todos modos' }).click()
  }
  await gui.waitForFunction(
    () => /Documentación guardada/.test(document.querySelector('.dialog h3')?.textContent ?? ''),
    null,
    { timeout: 20000 }
  )
  const reeditReport = await gui.locator('.dialog p').innerText()
  await gui.getByRole('button', { name: 'Cerrar' }).click()
  const reeditedMdx = g('show docs/matriculas:matriculas/crear-matricula/index.mdx')
  check(
    Number(g('rev-list --count docs/matriculas')) === commitsBefore + 1 &&
      /Paso corregido tras revisar el commit/.test(reeditedMdx),
    'Editar un commit: la corrección se registra encima, en la misma carpeta y rama',
    `${commitsBefore} → ${g('rev-list --count docs/matriculas')} commits · ${reeditReport.replace(/\n/g, ' ')}`
  )

  // --- Carpetas de capturas (§17) ---
  //
  // Un paso del manual que necesita VARIAS imágenes: las pantallas de un
  // asistente, lo que se ve antes y después. Se comprueba el circuito entero:
  // crear la carpeta vacía, meterle una tarjeta arrastrándola, que lo añadido con
  // la carpeta activa entre dentro, sacar algo con ⤴ y publicarlo como un solo
  // paso numerado con sus capturas debajo.
  const gitBoxFolder = gui.locator('.git-section input[type="checkbox"]').first()
  if (await gitBoxFolder.isChecked()) await gitBoxFolder.uncheck()
  await target.goto(fixture.url)
  await target.waitForLoadState('domcontentloaded')
  // Dos pasos sueltos: con «agrupar seguidos» dos clics del mismo tipo se
  // fundirían en uno y no habría nada que arrastrar.
  if (await gui.locator('.group-toggle input').isChecked()) {
    await gui.locator('.group-toggle input').uncheck()
  }
  await gui.click('.ctrl-record')
  await gui.waitForFunction(() =>
    document.querySelector('.status')?.textContent?.includes('Grabando')
  )
  await target.click('#nav-alumnos')
  await waitSteps(1, 'carpetas: paso A')
  await target.click('#nav-matriculas')
  await waitSteps(2, 'carpetas: paso B')
  await gui.evaluate(() => window.docrecorder.invoke('recorder:stop'))
  await gui.locator('.group-toggle input').check()

  // La carpeta se crea detrás de la tarjeta activa, como todo lo que se añade.
  await gui.locator('.step-card').first().locator('.step-badge').click()
  await gui.locator('.add-menu > button').click()
  await gui.locator('.add-menu-list button:has-text("Carpeta de capturas")').click()
  await gui.waitForSelector('.group-card', { timeout: 5000 })
  await gui.locator('.group-title').fill('Revisar el listado en las dos pantallas')
  check(
    (await gui.locator('.group-drop').count()) === 1 &&
      /Arrastra aquí/.test((await gui.locator('.group-drop').textContent()) ?? ''),
    'Carpetas: la carpeta nace vacía y dice dónde hay que soltar las tarjetas'
  )

  // Arrastrar una tarjeta hasta la zona de la carpeta la mete dentro. Las
  // posiciones se miden ANTES de empezar: dnd-kit resuelve la colisión contra los
  // rectángulos medidos al arrancar el arrastre, no contra los que se ven mientras
  // la lista se reacomoda.
  await gui.locator('.group-card').scrollIntoViewIfNeeded()
  const dropBox = await gui.locator('.group-drop').boundingBox()
  const dragged = await gui.locator('.step-card').nth(1).locator('.drag-handle').boundingBox()
  const fromX = dragged.x + dragged.width / 2
  const fromY = dragged.y + dragged.height / 2
  const toX = dropBox.x + dropBox.width / 2
  const toY = dropBox.y + dropBox.height / 2
  await gui.mouse.move(fromX, fromY)
  await gui.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await gui.mouse.move(fromX + ((toX - fromX) * i) / 12, fromY + ((toY - fromY) * i) / 12)
    await new Promise((r) => setTimeout(r, 25))
  }
  await gui.mouse.up()
  await gui.waitForFunction(
    () => document.querySelectorAll('.step-card.in-group').length === 1,
    null,
    {
      timeout: 5000
    }
  )
  const inFolder = await gui.evaluate(() => ({
    badge: document.querySelector('.step-card.in-group .step-badge')?.textContent ?? '',
    count: document.querySelector('.group-card .section-count')?.textContent ?? '',
    // El recuento del encabezado cuenta pasos del manual: la carpeta es uno y sus
    // capturas no cuentan aparte.
    header: document.querySelector('.panel-header .count')?.textContent ?? ''
  }))
  check(
    inFolder.badge === '2·1' && inFolder.count === '1' && inFolder.header === '2',
    'Carpetas: arrastrar una tarjeta a la zona la mete dentro y la renumera como captura',
    `chapa ${inFolder.badge}, ${inFolder.count} dentro, encabezado ${inFolder.header}`
  )

  // Trabajando dentro de la carpeta, lo que se añade entra DENTRO: es lo que se
  // estaba haciendo, y obligar a arrastrarlo después sería absurdo.
  await gui.locator('.group-card .group-title').click()
  await gui.locator('.add-menu > button').click()
  await gui.locator('.add-menu-list button:has-text("Bloque de contenido")').click()
  await gui.waitForFunction(
    () => document.querySelectorAll('.step-card.in-group').length === 2,
    null,
    {
      timeout: 5000
    }
  )
  check(true, 'Carpetas: lo que se añade con la carpeta activa entra dentro de ella')

  // Y ⤴ lo saca, dejándolo suelto justo detrás de la carpeta.
  await gui
    .locator('.step-card.in-group')
    .last()
    .locator('.icon-btn[title^="Sacar esta captura"]')
    .click()
  await gui.waitForFunction(
    () => document.querySelectorAll('.step-card.in-group').length === 1,
    null,
    {
      timeout: 5000
    }
  )
  const afterOut = await gui.evaluate(() =>
    [...document.querySelectorAll('.step-card, .group-card')].map((n) =>
      n.classList.contains('group-card')
        ? '📁'
        : n.classList.contains('in-group')
          ? '·'
          : n.querySelector('.step-badge')?.textContent
    )
  )
  check(
    afterOut.join('') === '1📁·3',
    'Carpetas: ⤴ saca la tarjeta de la carpeta y la deja justo detrás',
    afterOut.join(' ')
  )

  await gui.fill('.topbar input[placeholder="matriculas"]', 'matriculas')
  await gui.fill('.topbar input[placeholder="institucion"]', '')
  await gui.fill('.topbar input[placeholder="crear-matricula"]', 'con-carpeta')
  await gui.fill('.topbar input[placeholder="Crear una matrícula"]', 'Matrícula con carpeta')
  await gui.locator('.panel-header .controls .ctrl').nth(2).click()
  await gui.waitForSelector('.dialog', { timeout: 10000 })
  if (await gui.getByRole('button', { name: 'Guardar de todos modos' }).count()) {
    await gui.getByRole('button', { name: 'Guardar de todos modos' }).click()
  }
  await gui.waitForFunction(
    () => /Documentación guardada/.test(document.querySelector('.dialog h3')?.textContent ?? ''),
    null,
    { timeout: 15000 }
  )
  await gui.getByRole('button', { name: 'Cerrar' }).click()

  const folderDir = join(outDir, 'matriculas', 'con-carpeta')
  const folderMdx = readFileSync(join(folderDir, 'index.mdx'), 'utf8')
  const folderSession = JSON.parse(readFileSync(join(folderDir, 'session.json'), 'utf8'))
  const folderFlow = JSON.parse(readFileSync(join(folderDir, 'flow.json'), 'utf8'))
  const folderStep = folderSession.steps.find((s) => s.kind === 'group')
  const member = folderSession.steps.find((s) => s.groupId === folderStep?.id)
  check(
    !!folderStep && folderStep.screenshot === '' && !!member && !!member.screenshot,
    'Carpetas: la carpeta se guarda sin captura propia y sus pasos conservan la suya',
    `${folderStep?.title} · captura del miembro: ${member?.screenshot ?? '(ninguna)'}`
  )
  // La carpeta es UN paso numerado (aquí el 2) y su captura va debajo, sin número
  // propio: numerarla diría que hay que hacer dos cosas donde el manual describe
  // una. Por eso la página tiene dos pasos numerados y no tres.
  check(
    /^## 2\. Revisar el listado en las dos pantallas$/m.test(folderMdx) &&
      (folderMdx.match(/^## \d+\./gm) ?? []).length === 2 &&
      folderMdx.indexOf('## 2. Revisar') < folderMdx.indexOf(`(./${member?.screenshot})`),
    'Carpetas: la carpeta sale como UN paso numerado y su captura se publica dentro',
    (folderMdx.match(/^## .*/gm) ?? []).join(' / ')
  )
  check(
    !folderFlow.actions.some((a) => a.action === 'group') &&
      folderFlow.actions.some((a) => a.url && a.action === 'click'),
    'Carpetas: la carpeta no entra en flow.json, pero el paso que contiene sí',
    `${folderFlow.actions.length} acción(es)`
  )

  await gui.evaluate(() => window.docrecorder.invoke('draft:clear'))

  // --- Etapa 12: comprobar el sitio antes de registrar y vista previa (§18) ---
  //
  // El repositorio de la prueba no es un proyecto npm, así que hasta aquí no
  // había nada que comprobar (y guardar no se detenía). Se monta uno con la
  // misma forma que el Docusaurus de destino: `docusaurus.config.js`,
  // `package.json` con sus scripts y `docs/` como carpeta de salida. Los
  // comandos son de verdad —los ejecuta npm, en su propio proceso— pero rápidos:
  // «compilar» copia las páginas a `build/` y falla si alguna trae ROMPEME, que
  // es lo que aquí hace de MDX que Docusaurus no puede compilar.
  const site = mkdtempSync(join(tmpdir(), 'docrecorder-sitio-'))
  const siteDocs = join(site, 'docs')
  mkdirSync(join(site, 'scripts'), { recursive: true })
  mkdirSync(siteDocs, { recursive: true })
  writeFileSync(join(site, 'docusaurus.config.js'), 'module.exports = {}\n')
  writeFileSync(
    join(site, 'scripts', 'compilar.mjs'),
    [
      "import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'",
      "import { join } from 'node:path'",
      'const walk = (dir) =>',
      '  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>',
      "    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]",
      '  )',
      "const pages = existsSync('docs') ? walk('docs').filter((f) => f.endsWith('.mdx')) : []",
      "const roto = pages.find((f) => readFileSync(f, 'utf8').includes('ROMPEME'))",
      'if (roto) {',
      '  console.error(`Error: no se pudo compilar ${roto}`)',
      "  console.error('Unexpected token ROMPEME')",
      '  process.exit(1)',
      '}',
      "rmSync('build', { recursive: true, force: true })",
      'for (const page of pages) {',
      "  const out = join('build', page.replace(/^docs\\//, '').replace(/\\/index\\.mdx$/, ''))",
      '  mkdirSync(out, { recursive: true })',
      "  writeFileSync(join(out, 'index.html'), `<!doctype html><title>${page}</title>`)",
      '}',
      'console.log(`Compiladas ${pages.length} páginas`)'
    ].join('\n')
  )
  writeFileSync(
    join(site, 'scripts', 'servir.mjs'),
    [
      "import { createServer } from 'node:http'",
      "import { existsSync, readFileSync, statSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 3000)",
      'createServer((req, res) => {',
      "  const path = decodeURIComponent(req.url.split('?')[0])",
      "  const file = join('build', path, 'index.html')",
      '  if (existsSync(file) && statSync(file).isFile()) {',
      "    res.writeHead(200, { 'content-type': 'text/html' })",
      '    res.end(readFileSync(file))',
      '  } else {',
      '    res.writeHead(404)',
      "    res.end('no')",
      '  }',
      "}).listen(port, '127.0.0.1', () => console.log(`sirviendo en ${port}`))"
    ].join('\n')
  )
  writeFileSync(
    join(site, 'package.json'),
    JSON.stringify(
      {
        name: 'sitio-de-prueba',
        version: '0.0.0',
        private: true,
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          'lint:docs': 'node -e "process.exit(0)"',
          build: 'node scripts/compilar.mjs',
          serve: 'node scripts/servir.mjs'
        }
      },
      null,
      2
    )
  )
  const gs = (args) => execSync(`git ${args}`, { cwd: site, encoding: 'utf8' }).trim()
  execSync('git init -q -b main', { cwd: site })
  gs('config user.email prueba@ejemplo.com')
  gs('config user.name Prueba')
  gs('add -A')
  gs('commit -q -m "chore: sitio de prueba"')

  const comandos = await gui.evaluate(
    (dir) => window.docrecorder.invoke('checks:detect', dir),
    siteDocs
  )
  check(
    comandos !== null &&
      comandos.checks.map((c) => c.script).join(',') === 'typecheck,lint:docs,build' &&
      comandos.canServe === true &&
      comandos.projectRoot.endsWith(site.split('/').pop()),
    'Comprobación: se detectan los comandos del proyecto de destino, del más barato al más caro',
    comandos ? comandos.checks.map((c) => c.script).join(' → ') : '(ninguno)'
  )
  const sinProyecto = await gui.evaluate(
    (dir) => window.docrecorder.invoke('checks:detect', dir),
    outDir
  )
  check(
    sinProyecto === null,
    'Comprobación: un repositorio que no es un proyecto Docusaurus no ofrece nada que ejecutar',
    String(sinProyecto)
  )

  /** Guarda una guía en el sitio de prueba, con el título (y el commit) que se pidan. */
  const saveToSite = (feature, title, verify) =>
    gui.evaluate(
      ([dir, feature, title, verify]) =>
        window.docrecorder.invoke('session:save', {
          meta: {
            module: 'publicacion',
            feature,
            title,
            role: 'admin',
            baseUrl: 'http://x'
          },
          viewport: { width: 800, height: 600 },
          sessionId: `chk-${feature}`,
          createdAt: new Date().toISOString(),
          outputDir: dir,
          steps: [
            {
              id: 's1',
              order: 1,
              action: 'click',
              title,
              description: '',
              selectorCandidates: [],
              url: 'http://x',
              screenshot: '',
              boundingRect: { x: 0, y: 0, width: 1, height: 1 },
              includeInDocs: true,
              timestamp: 't',
              tempFile: ''
            }
          ],
          git: {
            enabled: true,
            branch: 'docs/publicacion',
            message: `docs(publicacion): ${feature}`,
            push: false,
            verify
          }
        }),
      [siteDocs, feature, title, verify]
    )

  const okSave = await saveToSite('guia-buena', 'Abrir el listado', true)
  check(
    okSave.checks?.ok === true &&
      okSave.checks.runs.map((r) => r.script).join(',') === 'typecheck,lint:docs,build' &&
      !!okSave.git,
    'Comprobación: si los tres comandos pasan, el commit se hace como siempre',
    okSave.checks ? okSave.checks.runs.map((r) => `${r.script} ${r.ms}ms`).join(' · ') : '(sin datos)'
  )

  // Vista previa: compila y sirve el sitio, y devuelve la dirección de ESTA guía
  // (no la portada). Se comprueba pidiéndola de verdad por HTTP.
  const vistaPrevia = await gui.evaluate(
    (dir) =>
      window.docrecorder.invoke('preview:start', {
        outputDir: dir,
        segments: ['publicacion', 'guia-buena']
      }),
    siteDocs
  )
  const served = vistaPrevia.url ? await fetch(vistaPrevia.url).catch(() => null) : null
  check(
    !!vistaPrevia.url &&
      vistaPrevia.url.endsWith('/publicacion/guia-buena/') &&
      served !== null &&
      served.status === 200,
    'Vista previa: el sitio se compila, se sirve y la dirección abre la guía recién guardada',
    vistaPrevia.url ?? vistaPrevia.error ?? '(sin dirección)'
  )
  const previewRunning = await gui.evaluate(() => window.docrecorder.invoke('preview:status'))
  await gui.evaluate(() => window.docrecorder.invoke('preview:stop'))
  const previewStopped = await gui.evaluate(() => window.docrecorder.invoke('preview:status'))
  const afterStop = vistaPrevia.url ? await fetch(vistaPrevia.url).catch(() => null) : 'nada'
  check(
    previewRunning.running === true && previewStopped.running === false && afterStop === null,
    'Vista previa: detenerla mata el servidor y libera el puerto',
    `en marcha ${previewRunning.running} → ${previewStopped.running}`
  )

  // Y el caso que justifica todo esto: una guía que el sitio no puede compilar.
  const commitsAntes = gs('rev-list --count --all')
  const badSave = await saveToSite('guia-rota', 'Paso ROMPEME', true)
  const commitsDespues = gs('rev-list --count --all')
  const fallo = badSave.checks?.runs.find((r) => !r.ok)
  check(
    badSave.checks?.ok === false &&
      fallo?.script === 'build' &&
      /ROMPEME/.test(fallo?.output ?? '') &&
      !badSave.git &&
      commitsAntes === commitsDespues,
    'Comprobación: si el sitio no compila NO se comitea, y el error del comando llega entero',
    `${fallo?.script ?? '(ninguno)'} · ${commitsAntes} commits antes y después`
  )
  check(
    existsSync(join(siteDocs, 'publicacion', 'guia-rota', 'index.mdx')),
    'Comprobación: el paquete sí queda escrito en disco, para poder corregirlo y reintentar'
  )
  // Las comprobaciones se saltan antes de fallar la primera: es lo que hace
  // «Registrar de todos modos» desde el aviso.
  const forzado = await saveToSite('guia-rota', 'Paso ROMPEME', false)
  check(
    !forzado.checks && !!forzado.git && Number(gs('rev-list --count --all')) > Number(commitsAntes),
    'Comprobación: «Registrar de todos modos» comitea sin ejecutar nada',
    forzado.git?.message ?? forzado.gitError ?? '(sin commit)'
  )

  // Y la sección del panel, que es donde se ve y se desactiva.
  await gui.fill('.topbar input[placeholder="Sin seleccionar"]', siteDocs)
  await gui.waitForSelector('.git-preview button', { timeout: 15000 })
  const seccion = await gui.evaluate(() => ({
    comandos: document.querySelector('.git-preview')?.previousElementSibling
      ? [...document.querySelectorAll('.git-section .git-toggle em')].map((n) => n.textContent)
      : [],
    previa: document.querySelector('.git-preview button')?.textContent ?? ''
  }))
  check(
    seccion.comandos.some((t) => t.includes('npm run build')) &&
      seccion.previa === 'Vista previa del sitio',
    'Comprobación: el panel enumera los comandos del proyecto y ofrece la vista previa',
    seccion.comandos.join(' | ')
  )

  // Restaura la preferencia de agrupar para no dejarla desactivada en la app real.
  await gui.evaluate(() => localStorage.removeItem('docrecorder.groupConsecutive')).catch(() => {})

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
  // Limpieza de un directorio temporal: si la app aún estaba escribiendo su
  // borrador al recibir la señal, el borrado puede fallar. Es ruido de
  // desmontaje y no debe enmascarar el resultado de las comprobaciones.
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (err) {
    console.log(`(no se pudo borrar el userData temporal: ${err.code ?? err.message})`)
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 600)
}
