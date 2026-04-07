import type { NextConfig } from "next";
import { execSync } from "child_process";

function gitInfo() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const date = execSync("git log -1 --format=%cI", { encoding: "utf8" }).trim();
    return { sha, date };
  } catch {
    const sha = process.env.BUILD_SHA?.slice(0, 7) ?? "unknown";
    return { sha, date: new Date().toISOString() };
  }
}

const { sha, date } = gitInfo();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_SHA: sha,
    NEXT_PUBLIC_BUILD_DATE: date,
  },
};

export default nextConfig;
