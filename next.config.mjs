/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  async redirects() {
    return [
      { source: "/stock-movement", destination: "/inventory/movement", permanent: true },
    ]
  },
}

export default nextConfig


