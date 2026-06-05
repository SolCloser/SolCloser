import type { Config } from "tailwindcss"

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        sol: {
          purple: "#9945FF",
          green: "#14F195",
          dark: "#0a0a0f",
          card: "#111118",
          border: "#1e1e2e",
          muted: "#6b7280",
        },
      },
    },
  },
  plugins: [],
}
export default config
