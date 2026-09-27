import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Optional standalone container target; preserve the default CI/server build.
  ...(process.env.STAGING_CONTAINER_BUILD === 'true' ? { output: 'standalone' as const } : {}),
  devIndicators: process.env.BROWSER_TEST_PORT ? false : undefined,
  // Browser suites start independent Next servers. Keep their route manifests
  // separate from each other and from the production build.
  distDir: /^\d{4,5}$/.test(process.env.BROWSER_TEST_PORT ?? "") ? `.next-browser-${process.env.BROWSER_TEST_PORT}` : ".next",
  // Browser tooling may add generated type paths; never rewrite the checked-in
  // production compiler configuration while validating the exact commit.
  typescript: { tsconfigPath: /^\d{4,5}$/.test(process.env.BROWSER_TEST_PORT ?? "") ? `.next-browser-${process.env.BROWSER_TEST_PORT}.tsconfig.json` : "tsconfig.json" },
  // Optional worker threads for Windows environments without subprocess pipes.
  experimental: { workerThreads: process.env.LOCAL_BUILD_WORKER_THREADS === "true", useTypeScriptCli: process.env.LOCAL_BUILD_WORKER_THREADS !== "true" },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "res.cloudinary.com" },
    ],
  },

  async redirects() {
    return [
      // Secondary domain -> primary canonical domain (301, permanent).
      // Also configure this redirect at the DNS/hosting level (see README
      // "Domain Configuration") — this app-level rule is a safety net for
      // any request that reaches the Next.js server directly.
      {
        source: "/:path*",
        has: [{ type: "host", value: "rentafourwheel.com" }],
        destination: "https://renta4wheel.com/:path*",
        statusCode: 301,
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.rentafourwheel.com" }],
        destination: "https://renta4wheel.com/:path*",
        statusCode: 301,
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.renta4wheel.com" }],
        destination: "https://renta4wheel.com/:path*",
        statusCode: 301,
      },
    ];
  },

  async headers() {
    return [
      {
        // Default: camera/microphone/geolocation disabled everywhere. Only
        // routes that actually need the camera (pickup/return photo
        // capture — customer check-in and host inspection workflows) get a
        // narrower override below; nothing currently uses geolocation, so
        // it stays denied globally.
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Customer check-in / condition-report photo capture.
        source: "/account/reservations/:path*",
        headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }],
      },
      {
        // Host pickup/return inspection photo capture.
        source: "/host/reservations/:path*",
        headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }],
      },
    ];
  },
};

export default nextConfig;
