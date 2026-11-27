import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly where: string;
  readonly onError: (message: string, stack: string | undefined, where: string) => void;
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

/** Catches render errors, reports them to the main-process error log and offers a reload. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError(
      error.message,
      error.stack ?? info.componentStack ?? undefined,
      this.props.where,
    );
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p>The error was written to the local log. Your history is safe.</p>
        <button
          type="button"
          className="button button--primary"
          onClick={() => window.location.reload()}
        >
          Reload window
        </button>
      </div>
    );
  }
}
