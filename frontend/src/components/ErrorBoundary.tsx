import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Shown instead of the page. A route boundary keeps the shell around it. */
  compact?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * The thing that stands between a rendering error and a blank white screen.
 *
 * Without one, any exception thrown while React renders unmounts the whole
 * tree: the user gets an empty page, no message, and no way forward except
 * guessing that a reload might help. That is the worst failure mode a web
 * application has, because it is indistinguishable from the site being down
 * and it takes the navigation with it.
 *
 * Deliberately a class. Error boundaries are the one thing hooks still cannot
 * express -- `componentDidCatch` has no hook equivalent.
 *
 * "Try again" clears the error and re-renders rather than reloading the page.
 * Most of these are a transient render against data that arrived in a shape
 * the page did not expect, and re-rendering after a refetch fixes them without
 * throwing away everything else the person had open.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is where this goes until there is somewhere better. The
    // component stack is the half that actually says which page broke.
    console.error("A page failed to render:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className={
          this.props.compact
            ? "flex min-h-[50svh] flex-col items-center justify-center gap-4 p-6 text-center"
            : "flex min-h-svh flex-col items-center justify-center gap-4 bg-secondary/30 p-6 text-center"
        }
      >
        <div className="flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive ring-1 ring-destructive/20">
          <AlertTriangle className="size-5" />
        </div>
        <div className="max-w-md space-y-1.5">
          <h1 className="t-heading">This page did not load properly</h1>
          <p className="t-body text-muted-foreground">
            Something went wrong while drawing it. Nothing you had saved is affected.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => this.setState({ error: null })} className="h-10 gap-1.5">
            <RotateCw className="size-4" />
            Try again
          </Button>
          <Button
            variant="outline"
            className="h-10"
            onClick={() => { window.location.href = "/portal"; }}
          >
            Back to the dashboard
          </Button>
        </div>
      </div>
    );
  }
}
