import { Component, type ReactNode } from 'react';

interface Props {
  fallback?: ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="flex items-center justify-center h-full text-red-400 text-xs p-4">
            <div>
              <div className="font-bold mb-1">Render error</div>
              <div className="font-mono opacity-75">{this.state.error.message}</div>
              <button
                className="mt-2 px-2 py-1 bg-gray-800 rounded hover:bg-gray-700"
                onClick={() => this.setState({ error: null })}
              >
                Retry
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
