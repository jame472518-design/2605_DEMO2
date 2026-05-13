import { Component, type ReactNode } from "react";

type State = { error: Error | null };

/**
 * Wraps the app so a render crash becomes a visible red banner instead of an
 * empty / black screen. Once we ship to booth this can be removed (or kept
 * as a defensive net — it's ~30 LOC).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.error) {
      const e = this.state.error;
      return (
        <div className="min-h-screen p-6 font-mono text-sm bg-ink-950 text-accent-danger">
          <h1 className="text-lg font-bold tracking-widest mb-3">
            ⚠ DASHBOARD CRASH
          </h1>
          <p className="mb-2 text-smoke-200">
            <span className="text-smoke-500">name:</span> {e.name}
          </p>
          <p className="mb-2 text-smoke-200 break-words">
            <span className="text-smoke-500">message:</span> {e.message}
          </p>
          <pre className="text-[11px] text-smoke-400 whitespace-pre-wrap leading-tight overflow-auto max-h-[60vh] border border-ink-700 p-2 bg-ink-900">
            {e.stack ?? "(no stack)"}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 border border-accent-info text-accent-info px-3 py-1.5 tracking-widest"
          >
            ▸ RETRY (clear state)
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="ml-2 border border-ink-600 text-smoke-300 px-3 py-1.5 tracking-widest"
          >
            ↻ RELOAD
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
