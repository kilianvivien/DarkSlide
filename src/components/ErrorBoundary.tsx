import * as React from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { appendDiagnostic } from '../utils/diagnostics';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKey: number;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      error: null,
      resetKey: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    appendDiagnostic({
      level: 'error',
      code: 'REACT_BOUNDARY',
      message: error.message,
      context: {
        componentStack: info.componentStack ?? null,
      },
    });
    this.props.onError?.(error, info);
  }

  private reset = () => {
    this.setState((current) => ({
      error: null,
      resetKey: current.resetKey + 1,
    }));
  };

  render() {
    const { error } = this.state;
    const { children, fallback } = this.props;

    if (error) {
      if (typeof fallback === 'function') {
        return fallback(error, this.reset);
      }

      return fallback ?? (
        <div className="flex h-full min-h-32 items-center justify-center bg-zinc-950/70 p-4 text-center text-sm text-zinc-300">
          <div>
            <p className="font-medium text-zinc-100">This section crashed.</p>
            <button
              type="button"
              onClick={this.reset}
              className="mt-3 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-900"
            >
              Reload Section
            </button>
          </div>
        </div>
      );
    }

    return <>{children}</>;
  }
}
