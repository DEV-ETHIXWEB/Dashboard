import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { plainDate } from "@/lib/money";

interface SavedRequest {
  id: string;
  subject: string;
  category: string;
  description: string;
  releaseAt: string | null;
}

/**
 * Requests this client chose to hold until their allowance resets.
 *
 * The ticket form promises that nothing they typed is lost when they run out
 * of updates. A promise like that has to be visible somewhere afterwards, or
 * it is indistinguishable from having thrown the request away -- so this sits
 * above the ticket list, says what is held and when it lands, and lets them
 * take it back.
 *
 * Renders nothing at all when there is nothing held, which is almost always.
 */
export function SavedRequests() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["queued-requests"],
    queryFn: () =>
      api<{ queued: SavedRequest[] }>("GET", "/tickets/queued").then((d) => d.queued),
    enabled: user?.role === "client",
  });

  const drop = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>("DELETE", `/tickets/queued/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["queued-requests"] });
      toast.success("Removed. It will not be raised.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not remove that"),
  });

  const held = data ?? [];
  if (held.length === 0) return null;

  return (
    <section className="rounded-2xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5">
      <h2 className="t-heading">Saved for when your updates reset</h2>
      <p className="mt-1 t-body text-muted-foreground">
        We have these written down. They become requests on the date shown, and nothing happens to
        them before that.
      </p>

      <ul className="mt-3 space-y-2">
        {held.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-2 rounded-lg bg-row px-3 py-2.5 ring-1 ring-row-border ring-inset sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate t-body font-medium">{item.subject}</p>
              <p className="truncate t-caption text-muted-foreground">
                {item.category}
                {item.releaseAt ? ` · Lands ${plainDate(item.releaseAt)}` : ""}
              </p>
            </div>
            <Button
              variant="ghost"
              className="h-9 shrink-0 px-3"
              disabled={drop.isPending}
              onClick={() => drop.mutate(item.id)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
