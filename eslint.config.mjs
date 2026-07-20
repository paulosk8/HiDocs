import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },

  js.configs.recommended,

  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'electron.vite.config.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    languageOptions: { globals: globals.browser }
  },
  ...tseslint.configs.recommended,

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },

  {
    // El observador corre dentro de la página documentada, donde `window` lleva
    // propiedades que solo existen en tiempo de ejecución.
    files: ['src/main/engine/observer.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  },

  {
    // Los scripts de prueba corren en Node pero evalúan código en el navegador.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-empty': 'off', '@typescript-eslint/no-unused-vars': 'off' }
  },

  prettier
)
