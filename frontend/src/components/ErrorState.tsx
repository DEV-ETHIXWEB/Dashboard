import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 0
      ? "Cannot reach the server. Check your connection and try again."
      : error.message;
  }
  if (error instanceof Error) return error.message;
  return "Please try again in a moment.";
}

export function ErrorState({
  title = "Something went wrong",
  error,
  onRetry,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl bg-destructive/5 px-5 py-10 text-center ring-1 ring-destructive/20">
      <AlertTriangle aria-hidden className="size-8 text-destructive" />
      <p className="text-lg font-semibold tracking-tight text-foreground">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{describeError(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-1 gap-1.5" onClick={onRetry}>
          <RotateCw aria-hidden className="size-3.5" />
          Try again
        </Button>
      )}
    </div>
  );
}
