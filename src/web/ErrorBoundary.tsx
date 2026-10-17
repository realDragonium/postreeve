import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  readonly label: string;
  /** Changing any value clears a caught error, so opening another message renders again. */
  readonly resetKeys?: readonly unknown[];
  /** Pane boundaries offer Try again; the shell boundary only offers Reload. */
  readonly retry?: boolean;
  /** Dialog boundaries show the fallback as a dialog with Close. */
  readonly onDismiss?: () => void;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  readonly keys: readonly unknown[] | undefined;
}

/** Keeps one render crash from blanking the interface. The message renders as text, never as HTML. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, keys: this.props.resetKeys };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    const changed = props.resetKeys?.length !== state.keys?.length
      || (props.resetKeys ?? []).some((key, index) => !Object.is(key, state.keys?.[index]));
    return changed ? { error: null, keys: props.resetKeys } : null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`Postreeve ${this.props.label} crashed`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const fallback = <div className="crash" role="alert" aria-label={`${this.props.label} error`}>
      <h2 className="crash-title">Something went wrong</h2>
      <p className="t-body">The {this.props.label} hit an error and stopped. Nothing was sent or changed by this error.</p>
      <pre className="crash-message">{error.message || error.name}</pre>
      <div className="crash-actions">
        {this.props.retry ? <button className="chip" onClick={() => this.setState({ error: null })}>Try again</button> : null}
        <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        {this.props.onDismiss ? <button className="btn-quiet" onClick={this.props.onDismiss}>Close</button> : null}
      </div>
    </div>;
    if (!this.props.onDismiss) return fallback;
    return <div className="overlay">
      <div className="backdrop" />
      <section className="sheet" role="dialog" aria-modal="true" aria-label={`${this.props.label} error`}>{fallback}</section>
    </div>;
  }
}
