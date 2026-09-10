import type { ViolationsConfig } from '@wadeck-app/violations-rules'

export default {
  projectTags: ['ts', 'cli'],
  globalExclude: [
    'node_modules/**',
    'dist/**',
    'dist-bundle/**',
    'packages/**',
  ],
  rules: {},
} satisfies ViolationsConfig
