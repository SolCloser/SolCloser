/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@privy-io/react-auth"],
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    }
    return config
  },
}

export default nextConfig
