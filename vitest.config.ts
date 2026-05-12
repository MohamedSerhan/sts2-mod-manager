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
      // sit a couple of points BELOW current actual coverage so a normal
      // working day with one or two refactors doesn't accidentally fail
      // the gate — but a meaningful regression (e.g. someone deletes a
      // test file or rips out a tested branch) still trips it.
      //
      // Actual coverage at the time of writing:
      //   Lines: 70.87%   · gate 68
      //   Funcs: 72.45%   · gate 70
      //   Branches: 65.62% · gate 63
      //   Statements: 69.65% · gate 67
      //
      // Target trajectory (per `qa/whats-left.md`):
      //   - Lines:      68 (gate) → 80 → 95 (goal)
      //   - Branches:   63 → 75 → 90
      //   - Functions:  70 → 85 → 95
      //   - Statements: 67 → 80 → 95
      //
      // The WebDriver smoke covers user *flows* end-to-end already;
      // these line-level gates protect the static branches the smoke
      // can't easily reach (empty states, error paths, advanced-mode
      // conditionals).
      thresholds: {
        lines: 68,
        functions: 70,
        branches: 63,
        statements: 67,
      },
    },
  },
});
