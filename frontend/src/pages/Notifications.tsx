import { toast } from "sonner";
import { Bell, Check, Trash2 } from "lucide-react";
import { useNotifications, useMarkNotificationRead, useClearAllNotifications } from "@/hooks/useData";
import { api } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { MoneyPanel, DataList, DataRow, BentoGrid, bento } from "@/components/money/Money";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { plainDate } from "@/lib/money";

export default function Notifications() {
  const { data: notifications, isLoading, isError, error, refetch } = useNotifications();
  const qc = useQueryClient();
  const markRead = useMarkNotificationRead();
  const clearAll = useClearAllNotifications();

  const markAllRead = useMutation({
    mutationFn: () => api("POST", "/notifications/read-all"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      toast.success("All caught up");
    },
  });

  function clear() {
    if (!window.confirm("Clear all notifications? This cannot be undone.")) return;
    clearAll.mutate(undefined, {
      onSuccess: () => toast.success("Notifications cleared"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to clear notifications"),
    });
  }

  const unread = notifications?.filter((n) => !n.read).length ?? 0;

  return (
    <BentoGrid className="mx-auto w-full max-w-6xl">
      <div className={bento(4)}>
      <PageHeader
        title="Notifications"
        description="Updates about your projects, requests, and account."
        actions={
          notifications && notifications.length > 0 ? (
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <Button variant="secondary" className="h-10 px-4" onClick={() => markAllRead.mutate()}>
                  <Check className="size-4" /> Mark all as read
                </Button>
              )}
              <Button variant="ghost" className="h-10 px-4 text-muted-foreground hover:text-destructive" onClick={clear} disabled={clearAll.isPending}>
                <Trash2 className="size-4" /> Clear all
              </Button>
            </div>
          ) : undefined
        }
      />
      </div>

      {isLoading ? (
        <Skeleton className={`h-64 w-full rounded-2xl ${bento(4)}`} />
      ) : isError ? (
        <div className={bento(4)}>
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : !notifications || notifications.length === 0 ? (
        <div className={bento(4)}>
          <EmptyState icon={Bell} title="No notifications" description="You are all caught up." />
        </div>
      ) : (
        <MoneyPanel
          className={bento(4)}
          title="Recent updates"
          subtitle={unread > 0 ? `${unread} unread` : "Nothing unread"}
        >
          <DataList>
            {notifications.map((n) => (
              <DataRow
                key={n.id}
                title={n.message}
                meta={plainDate(n.createdAt)}
                status={n.read ? undefined : "New"}
                action={
                  !n.read ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 shrink-0 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => markRead.mutate(n.id)}
                      disabled={markRead.isPending}
                    >
                      Mark read
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </DataList>
        </MoneyPanel>
      )}
    </BentoGrid>
  );
}
