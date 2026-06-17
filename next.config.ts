import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to silence the "Detected additional lockfiles" warning
  // (a parent directory has its own lockfile). cwd is the project root during `next build`.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
