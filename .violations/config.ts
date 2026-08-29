import type { ViolationsConfig } from '@wadeck/violations-rules'

export default {
  projectTags: ['ts', 'shared'],
  globalExclude: [
    'node_modules/**',
    'dist/**',
    'dist-bundle/**',
    'packages/**',
  ],
  rules: {},
} satisfies ViolationsConfig
