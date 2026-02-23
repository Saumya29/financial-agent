import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
      allowedOrigins: ["localhost:3000"],
    },
    clientRouterFilter: true,
  },
  // Increase timeout for long-running operations like Gmail sync
  serverExternalPackages: [],
};

export default nextConfig;
