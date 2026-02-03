import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  // Global ignores - must be first and standalone
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      'build/**',
      'coverage/**',
      '**/*.d.ts',
      '**/*.d.ts.map',
      '**/*.js.map',
      'bundle.js',
      'contracts/**',
      'infrastructure/**',
      'eslint.config.js',
      // Ignore compiled JS files in src directories (build artifacts)
      'shared/**/src/**/*.js',
      'services/**/src/**/*.js'
    ]
  },
  // Base JS config
  js.configs.recommended,
  // TypeScript SOURCE files only (exclude tests)
  {
    files: ['shared/**/*.ts', 'services/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/tests/**',
      '**/__tests__/**',
      '**/setupTests.ts',
      '**/test-utils/**',
      '**/setup/*.ts',
      '**/test-utils.ts'
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json'
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
        NodeJS: 'readonly',
        RequestInit: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        fetch: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      'no-console': 'warn',
      'no-useless-escape': 'warn',
      'no-useless-catch': 'warn',
      'no-control-regex': 'warn',
      'prefer-const': 'warn',
      'no-var': 'error'
    }
  },
  // TypeScript TEST files - no project requirement, relaxed rules
  {
    files: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/tests/**/*.ts',
      '**/__tests__/**/*.ts',
      '**/setupTests.ts',
      '**/test-utils/**/*.ts',
      '**/jest.*.setup.ts',
      '**/setup/*.ts',
      '**/test-utils.ts'
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        ...globals.node,
        ...globals.jest,
        ...globals.es2021,
        NodeJS: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': 'off', // Tests often have setup variables
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off', // Allow @ts-nocheck in tests
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-console': 'off',
      'no-undef': 'off', // Jest globals handled separately
      'no-unused-vars': 'off',
      'no-loss-of-precision': 'off', // Allow test constants
      'prefer-const': 'warn',
      'no-var': 'error'
    }
  },
  // Root-level TypeScript config files
  {
    files: ['*.ts', 'jest.*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        ...globals.node,
        ...globals.es2021
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off'
    }
  },
  // JavaScript files (CommonJS)
  {
    files: ['**/*.js', '**/*.cjs'],
    ignores: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.commonjs,
        ...globals.es2021,
        ...globals.jest
      }
    },
    rules: {
      'no-console': 'off',
      'prefer-const': 'warn',
      'no-var': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  // ES Module JavaScript files
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021
      }
    },
    rules: {
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error'
    }
  }
];
