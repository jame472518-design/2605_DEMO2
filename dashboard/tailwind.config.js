/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#0a0e1a", 900: "#0f1422", 800: "#161c2e", 700: "#1f2940" },
        accent: { warn: "#f59e0b", danger: "#ef4444", ok: "#10b981", info: "#3b82f6" },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["JetBrains Mono", "ui-monospace", "Menlo"],
      },
    },
  },
  plugins: [],
};
