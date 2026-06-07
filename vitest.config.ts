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
      // - type-only modules with no runtime behavior
      // - generated d.ts files
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/__test__/**',
        'src/main.tsx',
        'src/types.ts',
        'src/vite-env.d.ts',
        'src/**/*.d.ts',
      ],
      // Thresholds enforced on `npm run qa:coverage`. The numbers below
      // sit a couple of points BELOW current actual coverage so a normal
      // working day with one or two refactors doesn't accidentally fail
      // the gate — but a meaningful regression (e.g. someone deletes a
      // test file or rips out a tested branch) still trips it.
      //
      // Live coverage as of 2026-05-17 (post v1.5.0 i18n merge):
      //   Lines:      97.52% · gate 96
      //   Funcs:      97.16% · gate 96
      //   Branches:   90.78% · gate 90
      //   Statements: 96.09% · gate 96
      //
      // Branch gate dropped from 91 → 90 as a one-time concession when
      // v1.5.0 landed: the i18n / language-routing / LanguageSelect /
      // What's New notice work added ~3k LOC of new surface area, and
      // the existing zh-Hans coverage hadn't caught up yet (LanguageSelect
      // at 80% branch, language.ts at 81% are the obvious follow-up
      // targets). Ratchet back to 91 in a follow-up PR with more focused
      // tests on those files.
      //
      // Gates sit ~1 point below live so a single refactor doesn't trip
      // the build, but new features that ship without tests will. The
      // WebDriver smoke covers user *flows* end-to-end already; these
      // line-level gates protect the static branches the smoke can't
      // easily reach (empty states, error paths, advanced-mode
      // conditionals).
      thresholds: {
        lines: 96,
        functions: 96,
        branches: 90,
        statements: 96,
      },
    },
  },
});
