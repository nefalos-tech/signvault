import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:8787';

const nextConfig: NextConfig = {
  transpilePackages: ['@signvault/shared'],
  agentRules: false,
  // Gzip holds back the proxied /api/events SSE stream until it ends, so the feed would never update.
  compress: false,
  // The server serves everything under /api, so the browser and the phone need only this one origin.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
