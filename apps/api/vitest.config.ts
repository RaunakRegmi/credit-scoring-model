import { defineConfig } from 'vitest/config';

/**
 * Unit tests construct services with `new` rather than through the Nest DI container.
 *
 * That is deliberate and not just convenience: vitest transforms with esbuild, which cannot
 * emit `emitDecoratorMetadata`, so Nest cannot resolve constructor parameters by type here.
 * Wiring dependencies explicitly also makes each test state exactly what the unit under test
 * depends on, which is what a unit test should do anyway.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
  },
});
