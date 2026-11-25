import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@signvault/shared'],
  agentRules: false,
};

export default nextConfig;
