import type { BoundingRect, StepAction } from '../../shared/types'

/** Nombre de la función que el observador usa para hablar con Node (exposeBinding). */
export const EMIT_BINDING = '__docrecEmit'

/** Namespace que el observador instala en la página para que el motor lo controle. */
export const OBSERVER_NAMESPACE = '__docrec'

/**
 * Señales crudas leídas del elemento en el momento de la interacción.
 * El ranking y la puntuación de selectores se hacen en Node (`selectors.ts`);
 * aquí solo se recoge lo que exige acceso al DOM.
 */
export interface ElementSignals {
  tag: string
  type: string | null
  id: string | null
  testId: string | null
  role: string | null
  accessibleName: string | null
  text: string | null
  placeholder: string | null
  name: string | null
  cssPath: string | null
  /**
   * El elemento ES, CONTIENE o ETIQUETA un control donde se introduce un valor.
   *
   * Se resuelve aquí porque hace falta el DOM: un interruptor moderno es un
   * envoltorio con un `<input>` escondido dentro, y por su etiqueta y su rol
   * pasaría por un botón cualquiera. Sin esto rompería el grupo del formulario
   * al que pertenece.
   */
  fieldControl: boolean
  /** cuántos elementos del documento comparten cada señal (1 = selector único) */
  matches: {
    testId: number
    id: number
    roleName: number
    text: number
    cssPath: number
  }
}

export interface AncestorInfo {
  tag: string
  role: string | null
  testId: string | null
  accessibleName: string | null
}

/** Evento crudo que el observador envía al motor. */
export interface RawEvent {
  action: StepAction
  /** referencia al elemento, válida hasta que el motor llame a `release` */
  ref: number
  /**
   * Identidad de la fila de tabla que contiene al elemento, o `null` si no está
   * en ninguna. Junto con `tableRef`, `cellRef` y `colIndex` sitúa el control
   * dentro de la rejilla, que es lo que decide qué se funde en un paso: los
   * controles de una misma fila (un registro que se edita) o de una misma
   * columna (la misma acción repetida sobre varios registros).
   */
  rowRef: number | null
  /**
   * Identidad de esta carga de la página. Cambia con cada navegación real,
   * porque el observador se instala de nuevo en un contexto nuevo. Dos pasos de
   * cargas distintas NO se funden aunque la URL coincida: recargar y volver a
   * pulsar es otra cosa que pulsar dos veces seguidas.
   */
  loadRef: number
  /** identidad de la tabla que lo contiene, o `null` si no está en ninguna */
  tableRef: number | null
  /** identidad de la celda que lo contiene, o `null` */
  cellRef: number | null
  /** número de columna dentro de su fila, o `null` */
  colIndex: number | null
  /** texto del encabezado de esa columna, para poder titular el paso */
  colHeader: string | null
  url: string
  value?: string
  isPassword: boolean
  boundingRect: BoundingRect
  point: { x: number; y: number }
  signals: ElementSignals
  ancestors: AncestorInfo[]
  timestamp: string
}

export interface ObserverConfig {
  bindingName: string
  namespace: string
  /** ms tras los que se considera que un submit ya fue documentado por el clic previo */
  submitDedupeMs: number
}

/**
 * Resultado de resaltar: el rectángulo del último elemento marcado y si ese
 * elemento está **desvaneciéndose**.
 *
 * Lo segundo decide qué captura ilustra el paso: un menú que se cierra tras
 * elegir una opción sigue en el DOM unos cientos de milisegundos, medio
 * transparente. Capturarlo entonces documenta algo que ya no se lee.
 */
export interface HighlightResult {
  rect: BoundingRect
  faded: boolean
}

/**
 * Qué hay pintado por encima del elemento señalado. Decide si al recuadro se le
 * añade compensación de brillo, y si lo marcado se ve o no.
 */
export type CoverKind = 'none' | 'translucent' | 'opaque'

/**
 * Un elemento del grupo, tal como se le pide al observador que lo marque.
 *
 * Lleva **varias** referencias porque un campo puede haberse tocado más de una
 * vez (enfocarlo y escribir en él son dos eventos), y un `fallback` que resuelve
 * el motor con los selectores del paso cuando ninguna sigue viva: los frameworks
 * actuales reemplazan el nodo al re-renderizar —guardar un formulario, redibujar
 * una tabla—, y entonces la referencia apunta a un elemento que ya no está en el
 * documento aunque el campo siga a la vista.
 */
export interface GroupHighlightTarget {
  refs: number[]
  /** elemento localizado por selector en el proceso principal, o `null` */
  fallback: Element | null
}

/**
 * Cuántos elementos del grupo se pudieron marcar y en qué estado están.
 *
 * `blocked` cuenta los que están desvaneciéndose o tapados por algo opaco: la
 * captura los señalaría sin que se vean, así que quien la pide puede esperar un
 * momento y repetir (un menú que se cierra tarda unos cientos de milisegundos).
 * `dimmed` son los que están bajo un velo translúcido —el fondo de un modal— y a
 * los que sí se les devuelve el brillo dentro del recuadro.
 */
export interface GroupHighlightResult {
  marked: number
  missing: number
  blocked: number
  dimmed: number
  /**
   * Elementos que se están DESVANECIENDO (un menú que se cierra al elegir su
   * opción). Se cuentan aparte de `blocked` porque piden lo contrario: uno
   * tapado se vuelve a intentar y, si sigue tapado, se captura igual; uno que se
   * va no va a mejorar, y la captura buena es la que el paso ya tiene.
   */
  fading: number
}

/**
 * Script que corre dentro del sistema documentado.
 *
 * Se pasa a `page.addInitScript` (para sobrevivir recargas) y se evalúa también
 * sobre el documento ya cargado. Debe ser autocontenido: no puede referenciar
 * nada del ámbito del bundler.
 */
export function observerScript(config: ObserverConfig): void {
  const w = window as unknown as Record<string, unknown>
  // Solo el frame principal: las coordenadas de un iframe no son comparables
  // con las del viewport que se captura.
  if (window.top !== window) return
  if (w[config.namespace]) return

  const MAX_TEXT = 80
  /**
   * Identidad de esta carga de la página: el observador se instala una vez por
   * contexto, así que una navegación real trae un número nuevo. Es lo que
   * distingue «dos clics seguidos» de «un clic, una recarga y otro clic», que en
   * un manual no son lo mismo aunque la URL coincida.
   */
  const LOAD_REF = Date.now()
  /** Cuántas referencias a elementos se conservan para poder re-resaltarlas. */
  const MAX_REFS = 60
  const emit = w[config.bindingName] as ((event: RawEvent) => Promise<void>) | undefined

  const refs = new Map<number, Element>()
  let nextRef = 1
  let enabled = false
  let overlay: HTMLElement | null = null
  let pendingFill: { el: HTMLInputElement | HTMLTextAreaElement; value: string } | null = null
  /**
   * Último campo cerrado. Chromium puede emitir un `change` nativo adicional al
   * perder el foco un campo cuyo valor ya se cerró, y sin esta guarda el mismo
   * texto generaría dos pasos idénticos.
   */
  let lastFill: { el: Element; value: string } | null = null
  let lastFormInteraction: { form: HTMLFormElement; at: number } | null = null
  /**
   * Último clic documentado, para descartar los que reenvía el propio widget.
   * `viaPointer` marca los que se dieron por hechos desde `pointerdown` porque
   * el `click` no llegó nunca: si llega tarde, no debe duplicar el paso.
   */
  let lastClick: { el: Element; at: number; viaPointer: boolean } | null = null
  /** Ventana dentro de la cual un clic anidado se considera el mismo gesto. */
  const SAME_GESTURE_MS = 400
  /**
   * Gesto empezado con `pointerdown` sobre un control, a la espera de su `click`.
   *
   * Los menús de las librerías actuales se abren en `pointerdown` y montan
   * encima una capa de descarte; el `pointerup` cae en esa capa y el navegador
   * dispara el `click` sobre el ancestro común —normalmente `<body>`—, o no lo
   * dispara. En ambos casos el botón que se pulsó (el «Ver» de una tabla, por
   * ejemplo) no generaba ningún paso.
   */
  let pendingPointer: { el: Element; point: { x: number; y: number }; timer: number } | null = null
  /** Espera máxima por el `click` antes de dar el gesto por hecho. */
  const CLICK_FALLBACK_MS = 400

  /**
   * Identidades de la tabla y la fila que contienen al elemento, si las hay.
   *
   * Son lo que sitúa un control **dentro de la rejilla**: con la tabla, la fila y
   * el número de columna, la GUI puede decidir qué se funde en un paso y qué no
   * (misma fila = un registro que se edita; misma columna = la misma acción
   * repetida sobre varios registros; tablas distintas = nada que ver).
   */
  const nodeRefs = new WeakMap<Element, number>()
  let nextNodeRef = 1
  const refOfNode = (node: Element | null): number | null => {
    if (!node) return null
    let id = nodeRefs.get(node)
    if (id === undefined) {
      id = nextNodeRef++
      nodeRefs.set(node, id)
    }
    return id
  }

  const rowOf = (el: Element): Element | null => el.closest('tr,[role=row]')
  const cellOf = (el: Element): Element | null =>
    el.closest('td,th,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]')
  const rowRefOf = (el: Element): number | null => refOfNode(rowOf(el))
  const cellRefOf = (el: Element): number | null => refOfNode(cellOf(el))
  const tableRefOf = (el: Element): number | null =>
    refOfNode(el.closest('table,[role=table],[role=grid],[role=treegrid]'))

  /**
   * Número de columna del elemento dentro de su fila, o `null` fuera de una
   * tabla. Es la posición entre las celdas hermanas: `cellIndex` cuando el
   * navegador lo da (tablas HTML), y si no el índice entre hermanas, que es lo
   * que queda en las rejillas hechas con `div` y roles ARIA.
   */
  const colIndexOf = (el: Element): number | null => {
    const cell = cellOf(el)
    if (!cell) return null
    const index = (cell as HTMLTableCellElement).cellIndex
    if (typeof index === 'number' && index >= 0) return index
    const parent = cell.parentElement
    return parent ? Array.prototype.indexOf.call(parent.children, cell) : null
  }

  /**
   * Encabezado de esa columna, para poder titular el paso por lo que se hizo
   * («Rellenar «Nota» en 3 filas») en vez de por un número de columna, que no
   * significa nada en un manual.
   */
  const colHeaderOf = (el: Element): string | null => {
    const index = colIndexOf(el)
    if (index === null) return null
    const table = el.closest('table,[role=table],[role=grid],[role=treegrid]')
    if (!table) return null
    const headerRow = table.querySelector('thead tr,[role=rowgroup] [role=row],tr,[role=row]')
    const cell = headerRow?.children?.[index] ?? null
    if (!cell) return null
    const text = ((cell as HTMLElement).innerText ?? cell.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    return text ? text.slice(0, MAX_TEXT) : null
  }

  const clean = (s: string | null | undefined): string | null => {
    if (!s) return null
    const t = s.replace(/\s+/g, ' ').trim()
    return t ? t.slice(0, MAX_TEXT) : null
  }

  const visibleText = (el: Element): string | null => {
    const text = (el as HTMLElement).innerText ?? el.textContent ?? ''
    return clean(text)
  }

  /** Rol ARIA explícito o implícito para los tags que aparecen en flujos reales. */
  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.split(/\s+/)[0] ?? null
    const tag = el.tagName.toLowerCase()
    if (tag === 'button') return 'button'
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'hidden') return null
      return 'textbox'
    }
    return null
  }

  /**
   * Nombre accesible, versión pragmática del algoritmo de accname: cubre los
   * casos que aparecen en aplicaciones reales sin arrastrar la espec completa.
   */
  const accessibleNameOf = (el: Element): string | null => {
    const ariaLabel = clean(el.getAttribute('aria-label'))
    if (ariaLabel) return ariaLabel

    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n): n is HTMLElement => n !== null)
        .map((n) => n.innerText || n.textContent || '')
      const joined = clean(parts.join(' '))
      if (joined) return joined
    }

    const id = el.getAttribute('id')
    if (id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        const text = label ? clean((label as HTMLElement).innerText) : null
        if (text) return text
      } catch {
        /* id no escapable: se ignora */
      }
    }

    const wrappingLabel = el.closest('label')
    if (wrappingLabel) {
      const text = clean((wrappingLabel as HTMLElement).innerText)
      if (text) return text
    }

    const tag = el.tagName.toLowerCase()
    if (tag === 'img') {
      const alt = clean(el.getAttribute('alt'))
      if (alt) return alt
    }
    if (tag === 'input') {
      const input = el as HTMLInputElement
      const type = (input.type || 'text').toLowerCase()
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const v = clean(input.value)
        if (v) return v
      }
      const ph = clean(input.placeholder)
      if (ph) return ph
    }

    const title = clean(el.getAttribute('title'))
    if (title) return title

    // Para controles, el contenido visible es el nombre (botones, enlaces…).
    if (['button', 'a', 'summary', 'option', 'legend'].includes(tag) || el.getAttribute('role')) {
      return visibleText(el)
    }
    return null
  }

  /** Una clase es utilizable si no parece hasheada ni una utilidad de Tailwind. */
  const isStableClass = (cls: string): boolean => {
    if (cls.length > 25 || cls.length < 3) return false
    if (!/^[a-z][a-z0-9-]*$/.test(cls)) return false // descarta CamelCase y hashes
    if (/\d{2,}/.test(cls)) return false
    // utilidades típicas: p-4, mt-2, text-sm, grid-cols-3, w-full…
    if (/^(p|m|w|h|mt|mb|ml|mr|px|py|pt|pb|pl|pr|gap|text|bg|border|flex|grid|min|max)-/.test(cls))
      return false
    return true
  }

  /** CSS estructural corto: máximo 3 niveles, sin clases sospechosas (§4). */
  const cssPathOf = (el: Element): string | null => {
    const parts: string[] = []
    let node: Element | null = el
    for (let depth = 0; depth < 3 && node && node.nodeType === 1; depth++) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') break

      let part = tag
      const classes = Array.from(node.classList).filter(isStableClass)
      if (classes[0]) part += `.${classes[0]}`

      const parent: Element | null = node.parentElement
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
      }
      parts.unshift(part)

      const selector = parts.join(' > ')
      try {
        if (document.querySelectorAll(selector).length === 1) return selector
      } catch {
        return null
      }
      node = parent
    }
    const selector = parts.join(' > ')
    return selector || null
  }

  const countMatches = (selector: string | null): number => {
    if (!selector) return 0
    try {
      return document.querySelectorAll(selector).length
    } catch {
      return 0
    }
  }

  /** Cuántos elementos comparten el par rol+nombre accesible. */
  const countRoleName = (role: string | null, name: string | null): number => {
    if (!role || !name) return 0
    let count = 0
    const candidates = document.querySelectorAll<HTMLElement>(
      'a,button,input,select,textarea,summary,[role]'
    )
    for (const el of candidates) {
      if (roleOf(el) === role && accessibleNameOf(el) === name) count++
      if (count > 1) break
    }
    return count
  }

  /** Cuántos elementos tienen exactamente este texto visible. */
  const countText = (text: string | null): number => {
    if (!text) return 0
    let count = 0
    const candidates = document.querySelectorAll<HTMLElement>(
      'a,button,input,select,textarea,summary,[role],label,span,div,li,td,th,p,h1,h2,h3,h4,h5,h6'
    )
    for (const el of candidates) {
      if (clean(el.innerText) === text) count++
      if (count > 1) break
    }
    return count
  }

  const signalsOf = (el: Element): ElementSignals => {
    const testId = el.getAttribute('data-testid')
    const id = el.getAttribute('id')
    const role = roleOf(el)
    const accessibleName = accessibleNameOf(el)
    const text = visibleText(el)
    const cssPath = cssPathOf(el)

    let idMatches = 0
    if (id) {
      try {
        idMatches = document.querySelectorAll(`#${CSS.escape(id)}`).length
      } catch {
        idMatches = 0
      }
    }

    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      id,
      testId,
      role,
      accessibleName,
      text,
      placeholder: el.getAttribute('placeholder'),
      name: el.getAttribute('name'),
      fieldControl: controlsField(el),
      cssPath,
      matches: {
        testId: testId ? countMatches(`[data-testid="${CSS.escape(testId)}"]`) : 0,
        id: idMatches,
        roleName: countRoleName(role, accessibleName),
        text: countText(text),
        cssPath: countMatches(cssPath)
      }
    }
  }

  const ancestorsOf = (el: Element): AncestorInfo[] => {
    const list: AncestorInfo[] = []
    let node = el.parentElement
    while (node && list.length < 4 && node.tagName !== 'BODY') {
      list.push({
        tag: node.tagName.toLowerCase(),
        role: roleOf(node),
        testId: node.getAttribute('data-testid'),
        accessibleName: accessibleNameOf(node)
      })
      node = node.parentElement
    }
    return list
  }

  const rectOf = (el: Element): BoundingRect => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }

  const INTERACTIVE =
    'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"]'

  /**
   * Un clic suele aterrizar en un `<img>`, `<span>` o `<svg>` decorativo dentro
   * del control real. Ese hijo no tiene rol ni nombre accesible, así que el
   * selector degradaría a un CSS estructural frágil. Se sube al control que lo
   * contiene, que es además lo que describe el paso («clic en Documentación»).
   */
  const resolveInteractive = (el: Element): Element => {
    if (el.matches(INTERACTIVE)) return el
    const ancestor = el.closest(INTERACTIVE)
    if (!ancestor) return el
    // Solo unos pocos niveles: más arriba ya no se trata del mismo control.
    let depth = 0
    for (let n: Element | null = el; n && n !== ancestor; n = n.parentElement) depth++
    return depth <= 4 ? ancestor : el
  }

  /** Controles donde se introduce un valor, por etiqueta HTML y por rol ARIA. */
  const CONTROL_SELECTOR =
    'input:not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),' +
    'select,textarea,' +
    '[role=switch],[role=checkbox],[role=radio],[role=combobox],[role=listbox],' +
    '[role=textbox],[role=searchbox],[role=spinbutton],[role=slider]'

  /** Elementos interactivos que NUNCA son un campo, aunque estén junto a uno. */
  const NON_FIELD_SELECTOR = 'button,a,summary,[role=button],[role=link],[role=tab],[role=menuitem]'

  /**
   * Envoltorio del widget de un campo: el ancestro más cercano (pocos niveles)
   * que alberga EXACTAMENTE un control.
   *
   * Es la pieza clave para los interruptores modernos, donde el `<input>` real
   * está escondido y el texto que se pulsa es un hermano suyo, no un ancestro.
   * Exigir un único control evita que un formulario o una sección entera pasen
   * por widget.
   */
  const fieldWrapperOf = (el: Element): Element | null => {
    let node: Element | null = el
    for (let depth = 0; node && depth <= 3; depth++, node = node.parentElement) {
      if (node.tagName === 'FORM' || node.tagName === 'FIELDSET') return null
      if (node.querySelectorAll(CONTROL_SELECTOR).length === 1) return node
    }
    return null
  }

  /**
   * ¿Este clic acciona un campo? Cubre los casos reales: el propio control, una
   * `<label>` que lo acciona, y el envoltorio de un control estilizado.
   */
  const controlsField = (el: Element): boolean => {
    if (el.matches(CONTROL_SELECTOR)) return true
    // Un botón o un enlace junto a un campo siguen siendo botón y enlace: deben
    // cerrar el grupo del formulario, no unirse a él.
    if (el.matches(NON_FIELD_SELECTOR)) return false
    const label = el.closest('label') as HTMLLabelElement | null
    if (label && (label.control || label.querySelector(CONTROL_SELECTOR))) return true
    return fieldWrapperOf(el) !== null
  }

  const isTextLike = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => {
    if (el.tagName === 'TEXTAREA') return true
    if (el.tagName !== 'INPUT') return false
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'hidden'].includes(
      type
    )
  }

  const isPasswordField = (el: Element): boolean =>
    el.tagName === 'INPUT' && (el as HTMLInputElement).type.toLowerCase() === 'password'

  const send = (
    action: StepAction,
    el: Element,
    extra: { value?: string; point?: { x: number; y: number } }
  ): void => {
    if (!enabled || !emit) return
    const ref = nextRef++
    refs.set(ref, el)
    // Las acciones que pueden navegar se resaltan AQUÍ, de forma síncrona,
    // antes de que el navegador ejecute la acción por defecto. Una vez iniciada
    // la navegación, Chromium aplaza la ejecución de scripts, así que el motor
    // ya no podría dibujar nada: cuando lo intentase, la página sería otra y el
    // elemento que el paso señala habría desaparecido. El motor solo tiene que
    // capturar —eso sí llega—, y luego quita el overlay.
    if (action === 'click' || action === 'submit' || action === 'press') {
      highlight([ref])
    }
    // Las referencias ya no se liberan tras capturar: un paso puede fundirse
    // más tarde con los siguientes y hay que poder volver a marcar sus campos.
    // Se conservan las más recientes y se sueltan las viejas, para no retener
    // indefinidamente nodos que la página ya descartó.
    while (refs.size > MAX_REFS) {
      const oldest = refs.keys().next()
      if (oldest.done) break
      refs.delete(oldest.value)
    }
    const rect = rectOf(el)
    const event: RawEvent = {
      action,
      ref,
      loadRef: LOAD_REF,
      rowRef: rowRefOf(el),
      tableRef: tableRefOf(el),
      cellRef: cellRefOf(el),
      colIndex: colIndexOf(el),
      colHeader: colHeaderOf(el),
      url: location.href,
      isPassword: isPasswordField(el),
      boundingRect: rect,
      point: extra.point ?? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      signals: signalsOf(el),
      ancestors: ancestorsOf(el),
      timestamp: new Date().toISOString()
    }
    if (extra.value !== undefined) event.value = extra.value
    void emit(event)
  }

  /** Consolida en un solo paso todo lo tecleado en un campo (§3). */
  const flushPending = (): void => {
    if (!pendingFill) return
    const { el, value } = pendingFill
    pendingFill = null
    if (lastFill && lastFill.el === el && lastFill.value === value) return
    lastFill = { el, value }
    send('fill', el, { value: isPasswordField(el) ? '***' : value })
  }

  const noteFormInteraction = (el: Element): void => {
    const form = el.closest('form')
    if (form) lastFormInteraction = { form, at: Date.now() }
  }

  // --- listeners en fase de captura, para ver el evento antes que la app ---

  const cancelPendingPointer = (): void => {
    if (!pendingPointer) return
    clearTimeout(pendingPointer.timer)
    pendingPointer = null
  }

  /** Emite el paso de un clic ya decidido (llegara o no el evento `click`). */
  const emitClick = (
    target: Element,
    point: { x: number; y: number },
    viaPointer: boolean
  ): void => {
    lastClick = { el: target, at: Date.now(), viaPointer }
    flushPending()
    noteFormInteraction(target)
    send('click', target, { point })
  }

  /**
   * Un gesto empieza aquí, no en el `click`: si el widget se abre en
   * `pointerdown` y tapa la página con una capa de descarte, el `click` nunca
   * llega al control. Se anota el control y, si en `CLICK_FALLBACK_MS` no ha
   * llegado ningún `click`, se documenta el gesto igualmente.
   */
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!enabled || e.button !== 0) return
      const hit = (e.composedPath()[0] as Element) ?? (e.target as Element)
      if (!hit || hit.nodeType !== 1) return
      const target = resolveInteractive(hit)
      // Solo controles: un `pointerdown` sobre texto o sobre el fondo no es un
      // paso, y arrastrar algo tampoco (soltar fuera no es haber pulsado).
      if (!target.matches(INTERACTIVE) || hit.closest('[draggable="true"]')) return

      cancelPendingPointer()
      const point = { x: e.clientX, y: e.clientY }
      const timer = window.setTimeout(() => {
        pendingPointer = null
        if (!target.isConnected) return
        emitClick(target, point, true)
      }, CLICK_FALLBACK_MS)
      pendingPointer = { el: target, point, timer }
    },
    true
  )

  document.addEventListener(
    'click',
    (e) => {
      if (!enabled) return
      // composedPath resuelve el objetivo real dentro de shadow DOM y portales.
      const hit = (e.composedPath()[0] as Element) ?? (e.target as Element)
      if (!hit || hit.nodeType !== 1) return
      let target = resolveInteractive(hit)
      let point = { x: e.clientX, y: e.clientY }

      // El `pointerup` cayó en otra capa (la de descarte de un menú recién
      // abierto), así que el navegador dispara el clic sobre el ancestro común:
      // `<body>` o un contenedor cualquiera. El gesto fue sobre el control donde
      // empezó, no sobre el fondo, y documentarlo como «clic en <body>» sería
      // ruido inservible.
      if (!target.matches(INTERACTIVE) && pendingPointer?.el.isConnected) {
        target = pendingPointer.el
        point = pendingPointer.point
      }
      cancelPendingPointer()

      const now = Date.now()
      // El clic llegó tarde, después de dar el gesto por hecho: ya está contado.
      if (
        lastClick?.viaPointer &&
        lastClick.el === target &&
        now - lastClick.at < SAME_GESTURE_MS
      ) {
        return
      }

      // Un solo clic del usuario puede producir varios eventos: al pulsar una
      // `<label>` el navegador reenvía el clic a su control, y un interruptor
      // estilizado acciona por código el `<input>` que esconde. Serían dos o
      // tres pasos para lo que la persona vivió como uno, y encima el reenviado
      // trae peor selector (el `<input>` oculto no tiene nombre accesible).
      //
      // Se documenta el primero —el que se ve y se pulsa— y se descartan los
      // reenvíos. Son el mismo gesto si llegan enseguida y, además, uno contiene
      // al otro, comparten el envoltorio de un mismo campo, o el segundo no lo
      // generó una persona (`isTrusted` distingue el clic sintético).
      const wrapper = fieldWrapperOf(target)
      if (
        lastClick &&
        now - lastClick.at < SAME_GESTURE_MS &&
        lastClick.el !== target &&
        (lastClick.el.contains(target) ||
          target.contains(lastClick.el) ||
          !e.isTrusted ||
          (wrapper !== null && wrapper === fieldWrapperOf(lastClick.el)))
      ) {
        return
      }

      emitClick(target, point, false)
    },
    true
  )

  document.addEventListener(
    'input',
    (e) => {
      if (!enabled) return
      const target = (e.composedPath()[0] as Element) ?? (e.target as Element)
      if (!target || !isTextLike(target)) return
      // Cambiar de campo cierra el paso del campo anterior.
      if (pendingFill && pendingFill.el !== target) flushPending()
      pendingFill = { el: target, value: target.value }
    },
    true
  )

  document.addEventListener(
    'change',
    (e) => {
      if (!enabled) return
      const target = (e.composedPath()[0] as Element) ?? (e.target as Element)
      if (!target || target.nodeType !== 1) return

      if (target.tagName === 'SELECT') {
        flushPending()
        const select = target as HTMLSelectElement
        const label = select.selectedOptions[0]?.text ?? select.value
        send('select', select, { value: label })
        return
      }
      if (isTextLike(target)) {
        // `change` llega al perder el foco: es el momento de cerrar el paso.
        if (pendingFill && pendingFill.el === target) pendingFill.value = target.value
        else pendingFill = { el: target, value: target.value }
        flushPending()
      }
      // checkbox/radio ya quedaron documentados por su evento `click`.
    },
    true
  )

  document.addEventListener(
    'keydown',
    (e) => {
      if (!enabled || e.key !== 'Enter') return
      const target = (e.composedPath()[0] as Element) ?? (e.target as Element)
      if (!target || target.nodeType !== 1) return
      flushPending()
      noteFormInteraction(target)
      send('press', target, { value: 'Enter' })
    },
    true
  )

  document.addEventListener(
    'submit',
    (e) => {
      if (!enabled) return
      const form = (e.composedPath()[0] as HTMLFormElement) ?? (e.target as HTMLFormElement)
      if (!form) return
      flushPending()
      // Evita duplicar el paso: si el usuario acaba de pulsar el botón de envío
      // o Enter dentro de este formulario, ese paso ya describe la acción.
      const recent =
        lastFormInteraction &&
        lastFormInteraction.form === form &&
        Date.now() - lastFormInteraction.at < config.submitDedupeMs
      if (recent) return
      send('submit', form, {})
    },
    true
  )

  // Si el foco sale del campo sin disparar `change` (p. ej. el modal se cierra),
  // el paso del campo se cierra igualmente.
  document.addEventListener('focusout', () => {
    if (enabled) flushPending()
  })

  const removeOverlay = (): void => {
    overlay?.remove()
    overlay = null
  }

  /** Capa donde se pintan los recuadros: por encima de todo y sin capturar clics. */
  const newOverlay = (): HTMLElement => {
    const container = document.createElement('div')
    container.setAttribute('data-docrec-overlay', '')
    container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
    return container
  }

  /**
   * Recuadro rojo sobre un elemento.
   *
   * A propósito SIN número: el orden de los pasos cambia al eliminar o
   * reordenar, y un número pintado en el PNG no se puede rehacer —son píxeles—,
   * así que acabaría contradiciendo al paso que ilustra. El número lo pone quien
   * sí puede mantenerlo al día: la tarjeta del panel y el encabezado del manual.
   */
  const drawBox = (rect: DOMRect, cover: CoverKind): HTMLElement => {
    const box = document.createElement('div')
    box.style.cssText = [
      'position:fixed',
      `left:${rect.x - 3}px`,
      `top:${rect.y - 3}px`,
      `width:${rect.width + 6}px`,
      `height:${rect.height + 6}px`,
      'border:3px solid #FF5722',
      'border-radius:6px',
      'box-sizing:border-box',
      'pointer-events:none',
      'margin:0',
      'padding:0',
      // Si un velo translúcido apaga al elemento —el fondo de un modal, casi
      // siempre—, se le devuelve el brillo solo dentro del recuadro. Si no, el
      // paso señala un elemento apagado justo cuando pide mirarlo. Sin tapar
      // nada: `backdrop-filter` aclara lo que ya hay pintado debajo.
      //
      // SOLO con un velo translúcido. Aclarar lo que hay bajo un panel opaco (un
      // desplegable abierto sobre el formulario) no devuelve nada a la vista y
      // quema lo que sí se ve: con brillo 1.9 todo lo más claro que #868686
      // acaba en blanco puro, así que los bordes y el texto gris de los campos
      // desaparecen. Era lo que dejaba «borrosos» los campos del grupo.
      cover === 'translucent' ? 'backdrop-filter:brightness(1.9) saturate(1.15)' : ''
    ]
      .filter(Boolean)
      .join(';')

    return box
  }

  /** Alfa efectivo del fondo de un elemento (0 = transparente, 1 = opaco). */
  const backgroundAlpha = (style: CSSStyleDeclaration): number => {
    const color = style.backgroundColor
    if (!color || color === 'transparent') return 0
    const parts = color.match(/[\d.]+/g)
    if (!parts) return 0
    // `rgb(...)` sin alfa es opaco; `rgba(...)` trae el alfa en la cuarta parte.
    const alpha = parts.length >= 4 ? Number(parts[3]) : 1
    const own = Number(style.opacity)
    return (Number.isFinite(alpha) ? alpha : 1) * (Number.isFinite(own) ? own : 1)
  }

  /**
   * Qué hay pintado por encima del elemento, y cuánto tapa.
   *
   * Se pregunta por su centro: si lo que hay ahí no es él ni parte de él, algo se
   * le ha puesto delante. Pero «delante» no es una sola cosa, y tratarlas igual
   * era el error:
   *
   *  - `none` — nada, o algo **sin fondo**: el `<fieldset>` decorativo con el que
   *    las librerías de componentes dibujan el borde de un campo se lleva el
   *    `elementFromPoint` y no oscurece absolutamente nada.
   *  - `translucent` — un velo que deja ver, apagado: el fondo de un modal.
   *  - `opaque` — un panel que lo tapa del todo: un desplegable abierto sobre el
   *    formulario, un menú, una hoja lateral. El elemento no se ve, y no hay
   *    brillo que devolverle.
   *
   * Los overlays del propio grabador no interfieren: `pointer-events:none` los
   * excluye de `elementFromPoint`.
   */
  const OPAQUE_FROM = 0.9
  const VISIBLE_FROM = 0.05
  const coverOf = (el: Element, rect: DOMRect): CoverKind => {
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return 'none'
    const top = document.elementFromPoint(x, y)
    if (!top || top === el || el.contains(top) || top.contains(el)) return 'none'

    // Lo que tapa puede ser un hijo pequeño dentro del panel que de verdad tapa
    // (el texto de una opción dentro del desplegable), así que se acumula el
    // fondo más opaco de la cadena hasta el elemento tapado o el body.
    let alpha = 0
    for (let n: Element | null = top; n && n !== document.body; n = n.parentElement) {
      if (n === el || n.contains(el)) break
      alpha = Math.max(alpha, backgroundAlpha(getComputedStyle(n)))
      if (alpha >= OPAQUE_FROM) return 'opaque'
    }
    return alpha >= VISIBLE_FROM ? 'translucent' : 'none'
  }

  /**
   * ¿El elemento está desvaneciéndose (o ya invisible)?
   *
   * Los menús y los diálogos de las librerías actuales no se desmontan al
   * cerrarse: bajan su opacidad durante unos cientos de milisegundos y se
   * quitan después. Justo en esa ventana es cuando el grabador captura, y el
   * paso acababa ilustrando un menú medio borrado. La opacidad se acumula por
   * ancestros porque quien se desvanece es el contenedor, no la opción pulsada.
   */
  const FADED_BELOW = 0.6
  const isFading = (el: Element): boolean => {
    let opacity = 1
    for (let n: Element | null = el; n && n.nodeType === 1; n = n.parentElement) {
      const style = getComputedStyle(n)
      if (style.visibility === 'hidden' || style.display === 'none') return true
      const own = Number(style.opacity)
      opacity *= Number.isFinite(own) ? own : 1
      if (opacity < FADED_BELOW) return true
    }
    return false
  }

  /**
   * Dibuja el resaltado sobre uno o varios elementos y devuelve el rectángulo
   * del ÚLTIMO (el que motivó la captura).
   *
   * Se admiten varios porque un paso de formulario agrupado reúne varios campos
   * en una sola captura: marcar solo el último dejaría los demás sin señalar en
   * el manual, que es justo lo que el paso documenta.
   *
   * Los rectángulos se recalculan al capturar, no al registrar el evento: entre
   * uno y otro el layout puede haber cambiado o la página haber rodado.
   */
  const highlight = (targets: number[]): HighlightResult | null => {
    removeOverlay()

    const container = newOverlay()
    let last: HighlightResult | null = null
    let painted = 0
    for (const ref of targets) {
      const el = refs.get(ref)
      if (!el || !el.isConnected) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      container.appendChild(drawBox(rect, coverOf(el, rect)))
      painted++
      last = {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        faded: isFading(el)
      }
    }

    if (!painted) return null
    document.body.appendChild(container)
    overlay = container
    return last
  }

  /**
   * Resalta los elementos de un paso agrupado y cuenta en qué estado están.
   *
   * Se separa de `highlight` porque un grupo tiene dos exigencias que un paso
   * suelto no tiene:
   *
   *  - **Cada elemento puede haber cambiado de nodo.** Un formulario que se
   *    guarda, una tabla que se redibuja: el campo sigue en la pantalla, pero es
   *    otro nodo y la referencia guardada apunta al viejo. Por eso se acepta un
   *    `fallback` que el motor localiza con los selectores del paso, y por eso se
   *    prueban TODAS las referencias del campo.
   *  - **Hay que saber si lo marcado se ve.** Marcar cinco campos con un
   *    desplegable abierto encima documenta el desplegable, no los campos: quien
   *    pide la captura necesita saberlo para esperar y repetir.
   */
  const highlightGroup = (payload: { targets: GroupHighlightTarget[] }): GroupHighlightResult => {
    removeOverlay()

    const container = newOverlay()
    const result: GroupHighlightResult = {
      marked: 0,
      missing: 0,
      blocked: 0,
      dimmed: 0,
      fading: 0
    }

    for (const target of payload.targets ?? []) {
      let el: Element | null = null
      for (const ref of target.refs ?? []) {
        const candidate = refs.get(ref)
        if (candidate && candidate.isConnected) {
          el = candidate
          break
        }
      }
      if (!el && target.fallback && target.fallback.isConnected) el = target.fallback
      if (!el) {
        result.missing++
        continue
      }
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        result.missing++
        continue
      }
      const cover = coverOf(el, rect)
      container.appendChild(drawBox(rect, cover))
      result.marked++
      if (cover === 'translucent') result.dimmed++
      const fading = isFading(el)
      if (fading) result.fading++
      if (cover === 'opaque' || fading) result.blocked++
    }

    if (result.marked) {
      document.body.appendChild(container)
      overlay = container
    }
    return result
  }

  w[config.namespace] = {
    setEnabled: (value: boolean): void => {
      if (!value) flushPending()
      enabled = value
    },
    flushPending,
    highlight,
    highlightGroup,
    /** Qué referencias del grupo siguen apuntando a un elemento del documento. */
    groupRefsAlive: (groups: number[][]): boolean[] =>
      (groups ?? []).map((group) =>
        (group ?? []).some((ref) => {
          const el = refs.get(ref)
          return !!el && el.isConnected
        })
      ),
    clearHighlight: removeOverlay,
    release: (ref: number): void => {
      refs.delete(ref)
    }
  }
}
