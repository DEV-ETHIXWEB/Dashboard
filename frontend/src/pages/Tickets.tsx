import { useState } from "react";
import { toast } from "sonner";
import { Ticket as TicketIcon, Plus } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useTickets, useUpdateTicket, useUsers } from "@/hooks/useData";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { MoneyPanel, DataList, DataRow, BentoGrid, BentoColumns, bento } from "@/components/money/Money";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { plainDate } from "@/lib/money";
import { CreateTicketModal } from "@/components/CreateTicketModal";

const STAFF_STATUSES = ["Open", "In Progress", "Resolved", "Closed"];

export default function Tickets() {
  const { user } = useAuth();
  const { data: tickets, isLoading, isError, error, refetch } = useTickets();
  const { data: users } = useUsers();
  const updateTicket = useUpdateTicket();

  const isStaff = user && ["admin", "sales", "project_manager", "employee"].includes(user.role);
  const [open, setOpen] = useState(false);

  function changeStatus(id: string, status: string) {
    updateTicket.mutate(
      { id, patch: { status } },
      {
        onSuccess: () => toast.success("Ticket updated"),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to update ticket"),
      },
    );
  }

  const clientName = (id: string) => users?.find((u) => u.id === id)?.name ?? id;

  const CLOSED = ["Resolved", "Closed"];
  const openTickets = (tickets ?? []).filter((t) => !CLOSED.includes(t.status));
  const closedTickets = (tickets ?? []).filter((t) => CLOSED.includes(t.status));

  return (
    <BentoGrid className="mx-auto w-full max-w-6xl">
      <div className={bento(4)}>
        <PageHeader
          title="Your requests"
          description="Every request you send us, tracked from opened to resolved."
          actions={
            <CreateTicketModal
              open={open}
              onOpenChange={setOpen}
              trigger={
                <Button className="h-10 px-4 gap-2 font-medium">
                  <Plus className="size-4" /> New request
                </Button>
              }
            />
          }
        />
      </div>

      {isLoading ? (
        <Skeleton className={`h-64 w-full rounded-2xl ${bento(4)}`} />
      ) : isError ? (
        <div className={bento(4)}>
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : !tickets || tickets.length === 0 ? (
        <div className={bento(4)}>
        <EmptyState
          icon={TicketIcon}
          title="No requests yet"
          description="When you ask us something, it will show up here so you can follow along."
          action={
            <Button className="mt-1 h-10 px-4" onClick={() => setOpen(true)}>
              Ask us something
            </Button>
          }
        />
        </div>
      ) : (
        <div className={bento(4)}>
          <BentoColumns
            items={[
              {
                key: "open",
                node: (
                  <MoneyPanel title="Still open" subtitle={`${openTickets.length} waiting on us`}>
                    {openTickets.length === 0 ? (
                      <p className="py-1 text-sm text-muted-foreground">Nothing is waiting on us.</p>
                    ) : (
                      <DataList>
                        {openTickets.map((t) => (
                          <DataRow
                            key={t.id}
                            title={t.subject}
                            meta={[t.category, isStaff ? clientName(t.clientId) : null, `Asked ${plainDate(t.createdAt)}`]
                              .filter(Boolean)
                              .join(" · ")}
                            status={isStaff ? undefined : t.status}
                            action={
                              isStaff ? (
                                <Select value={t.status} onValueChange={(v) => changeStatus(t.id, v || "Open")}>
                                  <SelectTrigger size="sm" className="h-9 w-32 shrink-0">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {STAFF_STATUSES.map((s) => (
                                      <SelectItem key={s} value={s}>
                                        {s}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : undefined
                            }
                          />
                        ))}
                      </DataList>
                    )}
                  </MoneyPanel>
                ),
              },
              {
                key: "closed",
                node: (
                  <MoneyPanel title="Closed" subtitle={`${closedTickets.length} sorted out`}>
                    {closedTickets.length === 0 ? (
                      <p className="py-1 text-sm text-muted-foreground">Nothing closed yet.</p>
                    ) : (
                      <DataList>
                        {closedTickets.map((t) => (
                          <DataRow
                            key={t.id}
                            title={t.subject}
                            meta={[t.category, isStaff ? clientName(t.clientId) : null, `Asked ${plainDate(t.createdAt)}`]
                              .filter(Boolean)
                              .join(" · ")}
                            status={t.status}
                          />
                        ))}
                      </DataList>
                    )}
                  </MoneyPanel>
                ),
              },
            ]}
          />
        </div>
      )}
    </BentoGrid>
  );
}
