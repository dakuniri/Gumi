import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [
    {
      // PowerShell スクリプトを文字列として import できるようにする (esbuild の text loader と同等)
      name: 'ps1-text',
      load(id) {
        if (id.endsWith('.ps1')) {
          return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
        }
        return null;
      },
    },
  ],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
  },
});
