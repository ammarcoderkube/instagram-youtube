/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return [
      {
        source: "/api/reels/download",
        destination: "/api/download",
      },
      {
        source: "/api/reels/private/download",
        destination: "/api/download",
      },
      {
        source: "/api/reels/file/:filename*",
        destination: "/api/file/:filename*",
      },
      {
        source: "/api/reels/auth/:path*",
        destination: "/api/auth/:path*",
      },
      {
        source: "/api/reels/history",
        destination: "/api/history",
      },
    ];
  },
};

export default nextConfig;
