import { useEffect, useState } from "react";
import { LiveCamera } from "./components/LiveCamera";
import { LiveDescriber } from "./components/LiveDescriber";
import { VlmChat } from "./components/VlmChat";

/**
 * demo2 dashboard - simplified to a single split-screen analysis view.
 *   Left  : LiveCamera     (IRIS-01 MJPEG, full-bleed)
 *   Right : LiveDescriber  (vision-1 agent auto-running on a fixed interval)
 *
 * Header / sensor cards / alert banner / agent log / actuator panel are all
 * gone. The VlmChat page at #/vlm is still reachable via the floating chip
 * at top-right.
 */

type View = "dashboard" | "vlm";

function viewFromHash(): View {
  return window.location.hash.startsWith("#/vlm") ? "vlm" : "dashboard";
}

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (view === "vlm") return <VlmChat />;

  return (
    <div className="min-h-screen p-3 md:p-5 lg:p-6 relative">
      {/* Floating top telemetry strip (atmospheric cue from HUD v2) */}
      <div className="telemetry-strip fixed top-0 inset-x-0 z-[5] pointer-events-none" />

      {/* Floating [VLM] chip top-right - sole navigation link */}
      <a
        href="#/vlm"
        title="Open VLM chat"
        className="fixed top-3 right-3 md:top-4 md:right-4 z-[60] inline-flex items-center gap-2 border border-accent-photon/70 text-accent-photon hover:bg-accent-photon/10 px-3 py-1.5 font-mono text-[11px] tracking-hud transition-colors shadow-[0_0_12px_rgba(0,217,255,0.18)] bg-ink-950/80 backdrop-blur"
      >
        <span className="w-1.5 h-1.5 bg-accent-photon animate-breathe" aria-hidden />
        [VLM]
      </a>

      {/* Two-panel grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-5 lg:gap-6 max-w-[1800px] mx-auto">
        <LiveCamera />
        <LiveDescriber />
      </div>
    </div>
  );
}
