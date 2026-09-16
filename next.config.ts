import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
