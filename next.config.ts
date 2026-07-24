import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: [],
  experimental: {
    serverMinification: true
  }
};

export default nextConfig;
