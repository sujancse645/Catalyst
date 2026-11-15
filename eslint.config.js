// ESLint flat config — built-in rules only (no plugins), strict on correctness and security.
const shared = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always'],
  curly: ['error', 'multi-line'],
  'no-console': 'error',
  'no-shadow': 'error',
  'no-await-in-loop': 'off',
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-imports': 'error',
  'no-throw-literal': 'error',
  'no-return-await': 'error',
  'require-await': 'off',
  'object-shorthand': 'error',
  'prefer-template': 'error',
};

const nodeGlobals = {
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  AbortSignal: 'readonly',
  structuredClone: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setImmediate: 'readonly',
  console: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  Node: 'readonly',
  HTMLElement: 'readonly',
  Intl: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  createImageBitmap: 'readonly',
};

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  {
    files: ['server/**/*.js', 'tests/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: nodeGlobals },
    rules: shared,
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: browserGlobals },
    rules: shared,
  },
];
