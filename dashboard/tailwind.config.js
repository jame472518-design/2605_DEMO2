/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Mission-control oxide palette. Surfaces stay deeply neutral so
        // severity colors (warn/danger/ok) read as data, not chrome.
        ink: {
          950: "#080a0d",
          925: "#0a0c10",
          900: "#0b0d10",
          800: "#13161b",
          700: "#1c2026",
          600: "#252a32",
          500: "#3a4150",
        },
        smoke: {
          50: "#f5f6f8",
          100: "#e5e7eb",
          200: "#d1d5db",
          400: "#9ca3af",
          500: "#6b7280",
          600: "#4b5563",
        },
        accent: {
          warn: "#facc15",
          danger: "#ef4444",
          ok: "#10b981",
          info: "#06b6d4",
          // Higher-saturation cyan reserved for "LIVE / streaming / data-flowing"
          // — used sparingly so it reads as motion vs. info's static state.
          photon: "#00d9ff",
          // Between warn and danger — "approaching" state (ARMED sensors).
          ember: "#fb923c",
          // Strix Halo brand cue — reserved for the wordmark accent only.
          strix: "#ED1C24",
        },
      },
      fontFamily: {
        // JetBrains Mono everywhere by default — this dashboard is a HUD,
        // not a document. Noto Sans TC kicks in for Chinese glyphs.
        sans: [
          "JetBrains Mono",
          "Noto Sans TC",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "Menlo", "monospace"],
        han: ["Noto Sans TC", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      letterSpacing: {
        widest: "0.25em",
        hud: "0.32em",
      },
      animation: {
        "pulse-danger": "pulseDanger 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "pulse-dot": "pulseDot 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        scanline: "scanline 5.5s linear infinite",
        "slide-down": "slideDown 320ms cubic-bezier(0.16, 1, 0.3, 1)",
        "rec-blink": "recBlink 1.4s steps(2, end) infinite",
        breathe: "breathe 3.8s cubic-bezier(0.45, 0, 0.55, 1) infinite",
        "tick-pulse": "tickPulse 1.1s ease-out infinite",
        "telemetry-flow": "telemetryFlow 8s linear infinite",
        "border-sweep": "borderSweep 2.4s cubic-bezier(0.45, 0, 0.55, 1) infinite",
        "stagger-in": "staggerIn 520ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "digit-roll": "digitRoll 280ms cubic-bezier(0.22, 1, 0.36, 1)",
      },
      keyframes: {
        pulseDanger: {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(239, 68, 68, 0.55)" },
          "50%": { boxShadow: "0 0 0 8px rgba(239, 68, 68, 0)" },
        },
        pulseDot: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        scanline: {
          "0%": { transform: "translateY(-10%)" },
          "100%": { transform: "translateY(110%)" },
        },
        slideDown: {
          from: { opacity: "0", transform: "translateY(-12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        recBlink: {
          "0%": { opacity: "1" },
          "100%": { opacity: "0.25" },
        },
        breathe: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        tickPulse: {
          "0%": { transform: "scaleX(0)", opacity: "0" },
          "30%": { opacity: "1" },
          "100%": { transform: "scaleX(1)", opacity: "0" },
        },
        telemetryFlow: {
          from: { backgroundPositionX: "0" },
          to: { backgroundPositionX: "32px" },
        },
        borderSweep: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        staggerIn: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        digitRoll: {
          from: { transform: "translateY(-100%)", opacity: "0.4" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
