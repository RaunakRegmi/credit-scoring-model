import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // `@aics/contracts` is a workspace package shipped as CommonJS TypeScript output. Next has
  // to transpile it rather than treat it as a pre-built external.
  transpilePackages: ['@aics/contracts'],
  // Applicant financial data passes through this app; do not advertise the stack.
  poweredByHeader: false,
  typedRoutes: true,
};

export default config;
