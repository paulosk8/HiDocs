/**
 * Esqueletos de los bloques de contenido (§14).
 *
 * Los usan dos sitios: la barra del `ContentEditor` (insertar un bloque dentro
 * de lo ya escrito) y el menú «＋ Añadir» (crear el paso ya sembrado con el tipo
 * que se eligió). Viven aquí para que insertar una tabla desde la barra y crear
 * un paso de tabla den exactamente el mismo punto de partida.
 */

export const TABLE_TEMPLATE = [
  '| Campo | Descripción | Obligatorio |',
  '| --- | --- | :---: |',
  '| Nombre | Nombre completo de la persona | Sí |',
  '| Correo | Correo institucional | No |'
].join('\n')

export const CODE_TEMPLATE = [
  '```json title="ejemplo.json"',
  '{',
  '  "clave": "valor"',
  '}',
  '```'
].join('\n')

export const TABS_TEMPLATE = [
  '<Tabs>',
  '  <TabItem value="admin" label="Administrador">',
  '  Lo que ve el rol Administrador.',
  '  </TabItem>',
  '  <TabItem value="docente" label="Docente">',
  '  Lo que ve el rol Docente.',
  '  </TabItem>',
  '</Tabs>'
].join('\n')

export const DETAILS_TEMPLATE = [
  '<details>',
  '  <summary>Ver el detalle</summary>',
  '',
  '  Contenido que se muestra al desplegar.',
  '',
  '</details>'
].join('\n')

/** Qué se puede añadir desde «＋ Añadir → ▦ Bloque de contenido». */
export type ContentKind = 'table' | 'code' | 'tabs' | 'details' | 'text'

/**
 * Cada tipo con lo que hace falta para pintarlo en el menú y sembrar el paso.
 * «Texto libre» no siembra nada a propósito: es prosa, y una plantilla ahí solo
 * daría trabajo de borrado.
 */
export const CONTENT_KINDS: Array<{
  kind: ContentKind
  label: string
  hint: string
  template: string
}> = [
  {
    kind: 'table',
    label: '▦ Tabla',
    hint: 'Campos y valores, en columnas',
    template: TABLE_TEMPLATE
  },
  {
    kind: 'code',
    label: '{ } Código',
    hint: 'Un fragmento con su lenguaje y su título',
    template: CODE_TEMPLATE
  },
  {
    kind: 'tabs',
    label: '⇉ Pestañas',
    hint: 'La misma pantalla según el rol o el caso',
    template: TABS_TEMPLATE
  },
  {
    kind: 'details',
    label: '▸ Detalle',
    hint: 'Un desplegable para lo que no todos necesitan',
    template: DETAILS_TEMPLATE
  },
  {
    kind: 'text',
    label: '¶ Texto libre',
    hint: 'Markdown a secas: párrafos, listas, enlaces',
    template: ''
  }
]
