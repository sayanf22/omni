import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-bg flex items-center justify-center p-6 text-text font-sans">
          <div className="w-full max-w-md bg-surface border border-border rounded-xl p-8 shadow-2xl space-y-6">
            <div className="flex items-center gap-3 text-error">
              <div className="w-10 h-10 rounded-lg bg-error-dim/20 flex items-center justify-center font-bold text-xl">
                ⚠️
              </div>
              <div>
                <h2 className="text-lg font-bold">Application Error</h2>
                <p className="text-xs text-text-muted">An unexpected crash occurred</p>
              </div>
            </div>

            <div className="bg-surface2 border border-border p-4 rounded-lg text-xs font-mono text-text-muted overflow-auto max-h-48 whitespace-pre-wrap">
              {this.state.error?.stack || this.state.error?.toString() || "Unknown rendering error"}
            </div>

            <div className="flex gap-3">
              <button
                onClick={this.handleReset}
                className="flex-1 py-2.5 bg-accent hover:bg-accent-hover text-accent-contrast text-sm font-semibold rounded-md transition-colors"
              >
                Reload Application
              </button>
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="flex-1 py-2.5 border border-border hover:bg-surface2 text-text text-sm font-semibold rounded-md transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
