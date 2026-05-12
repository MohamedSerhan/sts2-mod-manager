import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest config for the frontend test suite.
//
// We run in jsdom so React components can mount and Testing Library
// queries work. The Tauri SDK is mocked in `src/__test__/setup.ts`
// — every component test gets a `registerInvokeHandler` helper that
// fakes one Tauri command at a time without spinning up the real
// backend.
//
// Coverage thresholds are enforced (lines/branches/functions). The
// goal is "almost 100% of user-facing surfaces"; raise thresholds
// when we have headroom, never lower them silently.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__test__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    server: {
      deps: {
        // The changelog parser does `import '../../CHANGELOG.md?raw'`.
        // Vite's `?raw` query suffix lets the test runner inline the
        // file contents at module load, same as in the app bundle.
        inline: [/\?raw$/],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Only measure code that actually ships to users. Excludes:
      // - main.tsx / Vite glue (no behavior to test)
      // - .test.ts(x) themselves
      // - the test setup file
      // - generated d.ts files
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/__test__/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/**/*.d.ts',
      ],
      // Thresholds enforced on `npm run qa:coverage`. The numbers below
      // are the current floor — raise as the suite grows, never lower
      // silently. Each test added that bumps the actual percentage is a
      // candidate for raising the corresponding gate.
      //
      // Target trajectory (per `qa/whats-left.md`):
      //   - Lines:      55 (now) → 75 (next milestone) → 95 (goal)
      //   - Branches:   47 → 65 → 90
      //   - Functions:  59 → 75 → 95
      //   - Statements: 55 → 75 → 95
      //
      // The WebDriver smoke covers user *flows* end-to-end already;
      // these line-level gates protect the static branches the smoke
      // can't easily reach (empty states, error paths, advanced-mode
      // conditionals).
      thresholds: {
        lines: 69,
        functions: 71,
        branches: 64,
        statements: 68,
      },
    },
  },
});
