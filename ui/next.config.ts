import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: the build emits plain HTML/JS/CSS into ../public, which
  // the atem-controller express server serves. No Next server on the Pi.
  output: "export",
  distDir: "../public",
  images: { unoptimized: true },
};

export default nextConfig;
