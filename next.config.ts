import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
        permanent: true,
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.rentafourwheel.com" }],
        destination: "https://renta4wheel.com/:path*",
        permanent: true,
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.renta4wheel.com" }],
        destination: "https://renta4wheel.com/:path*",
        permanent: true,
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
        source: "/account/trips/:path*",
        headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }],
      },
      {
        // Host pickup/return inspection photo capture.
        source: "/host/bookings/:path*",
        headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }],
      },
    ];
  },
};

export default nextConfig;
