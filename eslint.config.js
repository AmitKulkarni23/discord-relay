import babelParser from '@babel/eslint-parser'
import hooks from 'eslint-plugin-react-hooks'

// Prettier owns formatting and tsc owns types. This only checks what neither can: the rules of React hooks.
// Babel parses the TypeScript because typescript-eslint does not support TypeScript 7 yet.
export default [
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins: ['typescript', 'jsx'] } },
      },
    },
    plugins: { 'react-hooks': hooks },
    rules: hooks.configs.recommended.rules,
  },
]
