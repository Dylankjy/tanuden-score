import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  {
    ignores: ['dist']
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{js,cjs,mjs,ts}'],
    plugins: {
      unicorn: eslintPluginUnicorn
    },
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node
    },
    rules: {
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase'
        }
      ],
      // all env access must go through src/constants.ts, never bare process.env.
      'no-process-env': 'error'
    }
  },
  eslintPluginPrettierRecommended
);
