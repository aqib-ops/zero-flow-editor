import React from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a renderer-side crash from blanking the whole editor. The fallback is
 * intentionally plain so it still renders even if a UI primitive is the thing
 * that failed.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ui] unhandled render error", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
        <h1 className="text-sm font-semibold">Something went wrong in the editor</h1>
        <p className="max-w-md text-xs text-muted-foreground">
          {error.message || "An unexpected error occurred while rendering the interface."}
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
