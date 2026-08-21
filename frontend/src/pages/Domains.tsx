import { useState } from "react";
import { toast } from "sonner";
import { Globe, Plus, Pencil, Trash2, RotateCw, Loader2, X } from "lucide-react";
import { useDomains, useUsers, useCreateDomain, useUpdateDomain, useRenewDomain, useDeleteDomain } from "@/hooks/useData";
import { useAuth } from "@/context/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { MoneyPanel, DataList, DataRow, BentoGrid, bento } from "@/components/money/Money";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import { plainDate } from "@/lib/money";
import type { Domain } from "@/lib/entities";

const RENEWAL_WARNING_DAYS = 45;

function toDisplayDate(isoDate: string): string {
  if (!isoDate) return "";
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function Domains() {
  const { user } = useAuth();
  const { data: domains, isLoading, isError, error, refetch } = useDomains();
  const { data: users } = useUsers();
  const createDomain = useCreateDomain();
  const updateDomain = useUpdateDomain();
  const renewDomain = useRenewDomain();
  const deleteDomain = useDeleteDomain();

  const isStaff = user != null && ["admin", "sales", "project_manager"].includes(user.role);
  const canDelete = user?.role === "admin";
  const clients = (users ?? []).filter((u) => u.role === "client");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Domain | null>(null);
  const [clientId, setClientId] = useState("");
  const [domainName, setDomainName] = useState("");
  const [platform, setPlatform] = useState("");
  const [hostingProvider, setHostingProvider] = useState("");
  const [hostingRegion, setHostingRegion] = useState("");
  const [registrar, setRegistrar] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [notes, setNotes] = useState("");
  const [renewingId, setRenewingId] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setClientId(clients[0]?.id ?? "");
    setDomainName("");
    setPlatform("");
    setHostingProvider("");
    setHostingRegion("");
    setRegistrar("");
    setExpiresAt("");
    setNotes("");
    setOpen(true);
  }

  function openEdit(d: Domain) {
    setEditing(d);
    setClientId(d.clientId);
    setDomainName(d.domainName);
    setPlatform(d.platform);
    setHostingProvider(d.hostingProvider);
    setHostingRegion(d.hostingRegion);
    setRegistrar(d.registrar);
    setExpiresAt("");
    setNotes(d.notes);
    setOpen(true);
  }

  function submit() {
    if (!domainName.trim()) {
      toast.error("Domain name is required");
      return;
    }
    const shared = {
      domainName, platform, hostingProvider, hostingRegion, registrar, notes,
      ...(expiresAt ? { expiresAt: toDisplayDate(expiresAt) } : {}),
    };
    if (editing) {
      updateDomain.mutate(
        { id: editing.id, patch: shared },
        {
          onSuccess: () => {
            toast.success("Domain updated");
            setOpen(false);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to update domain"),
        },
      );
    } else {
      if (!clientId) {
        toast.error("Select a client");
        return;
      }
      createDomain.mutate(
        { clientId, ...shared },
        {
          onSuccess: () => {
            toast.success("Domain added");
            setOpen(false);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add domain"),
        },
      );
    }
  }

  function renew(d: Domain) {
    setRenewingId(d.id);
    renewDomain.mutate(d.id, {
      onSuccess: () => toast.success(`${d.domainName} renewed`),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to renew domain"),
      onSettled: () => setRenewingId(null),
    });
  }

  function remove(d: Domain) {
    if (!window.confirm(`Remove "${d.domainName}"? This cannot be undone.`)) return;
    deleteDomain.mutate(d.id, {
      onSuccess: () => toast.success("Domain removed"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove domain"),
    });
  }

  const clientName = (id: string) => users?.find((u) => u.id === id)?.name ?? id;
  const daysLeft = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  const sorted = [...(domains ?? [])].sort((a, b) => daysLeft(a.expiresAt) - daysLeft(b.expiresAt));

  return (
    <BentoGrid className="mx-auto w-full max-w-6xl">
      <div className={bento(4)}>
        <PageHeader
          title="Website addresses"
          description="Security certificates and renewal dates for every address we look after."
          actions={
            isStaff ? (
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger render={<Button onClick={openCreate} className="h-10 px-4 gap-2 font-medium" />}>
                  <Plus className="size-4" /> Add Domain
                </DialogTrigger>
                <DialogContent
                  showCloseButton={false}
                  className="sm:max-w-md p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
                >
                  <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                          <Globe className="size-5" />
                        </div>
                        <div>
                          <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                            {editing ? "Edit Domain" : "Add Domain"}
                          </DialogTitle>
                          <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                            {editing ? "Update details for this website address." : "Add a new website address for a client."}
                          </DialogDescription>
                        </div>
                      </div>
                      <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
                        <X className="size-4" />
                      </DialogClose>
                    </div>
                  </div>

                  <div className="no-scrollbar max-h-[72svh] space-y-4 overflow-y-auto overscroll-contain p-6">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Client *</Label>
                      <Select
                        items={Object.fromEntries(clients.map((c) => [c.id, c.company || c.name]))}
                        value={clientId}
                        onValueChange={(v) => setClientId(v ?? "")}
                        disabled={Boolean(editing)}
                      >
                        <SelectTrigger className="w-full bg-background/50 border-border/60">
                          <SelectValue placeholder="Select client" />
                        </SelectTrigger>
                        <SelectContent>
                          {clients.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.company || c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Domain Name *</Label>
                      <Input
                        value={domainName}
                        onChange={(e) => setDomainName(e.target.value)}
                        placeholder="e.g. example.com"
                        className="bg-background/50 border-border/60"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Platform</Label>
                        <Input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="e.g. WordPress" className="bg-background/50 border-border/60" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Registrar</Label>
                        <Input value={registrar} onChange={(e) => setRegistrar(e.target.value)} placeholder="e.g. Namecheap" className="bg-background/50 border-border/60" />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Hosting Provider</Label>
                        <Input value={hostingProvider} onChange={(e) => setHostingProvider(e.target.value)} placeholder="e.g. Vercel" className="bg-background/50 border-border/60" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Hosting Region</Label>
                        <Input value={hostingRegion} onChange={(e) => setHostingRegion(e.target.value)} placeholder="e.g. us-east-1" className="bg-background/50 border-border/60" />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">
                        {editing ? "New Expiry Date (leave blank to keep current)" : "Expiry Date"}
                      </Label>
                      <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="bg-background/50 border-border/60" />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Notes</Label>
                      <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="bg-background/50 border-border/60 resize-none" />
                    </div>
                  </div>

                  <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
                    <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />}>
                      Cancel
                    </DialogClose>
                    <Button
                      onClick={submit}
                      disabled={createDomain.isPending || updateDomain.isPending || !domainName.trim()}
                      className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs"
                    >
                      {createDomain.isPending || updateDomain.isPending ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Saving…
                        </>
                      ) : editing ? (
                        "Save changes"
                      ) : (
                        "Add domain"
                      )}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
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
      ) : sorted.length === 0 ? (
        <div className={bento(4)}>
          <EmptyState
            icon={Globe}
            title="No website addresses yet"
            description="Addresses and hosting details will appear here once they are set up."
          />
        </div>
      ) : (
        <MoneyPanel
          className={bento(4)}
          title="Your addresses"
          subtitle={`${sorted.length} looked after by us · soonest renewal first`}
        >
          <DataList>
            {sorted.map((d) => {
              const days = daysLeft(d.expiresAt);
              const soon = days > 0 && days < RENEWAL_WARNING_DAYS;
              const remaining = days > 0 ? `${days} days` : "Expired";
              return (
                <DataRow
                  key={d.id}
                  title={d.domainName}
                  meta={[
                    isStaff ? clientName(d.clientId) : null,
                    `Certificate ${d.sslStatus}`,
                    d.hostingProvider,
                    `Renews ${plainDate(d.expiresAt)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  status={soon ? undefined : remaining}
                  flag={soon ? remaining : undefined}
                  action={
                    isStaff ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Renew ${d.domainName} for one year`}
                          className="hover:bg-primary/10 hover:text-primary"
                          onClick={() => renew(d)}
                          disabled={renewingId === d.id}
                          title="Renew for one year"
                        >
                          <RotateCw aria-hidden className={`size-3.5 ${renewingId === d.id ? "animate-spin" : ""}`} />
                        </Button>
                        <Button variant="ghost" size="icon-xs" aria-label={`Edit ${d.domainName}`} className="hover:bg-primary/10 hover:text-primary" onClick={() => openEdit(d)}>
                          <Pencil aria-hidden className="size-3.5" />
                        </Button>
                        {canDelete && (
                          <Button variant="ghost" size="icon-xs" aria-label={`Delete ${d.domainName}`} className="hover:bg-destructive/10 hover:text-destructive text-destructive/80" onClick={() => remove(d)}>
                            <Trash2 aria-hidden className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    ) : undefined
                  }
                />
              );
            })}
          </DataList>
        </MoneyPanel>
      )}
    </BentoGrid>
  );
}
