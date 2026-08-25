import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Download, Eye, FileText, Plus, Trash2, Loader2, X, Upload as UploadIcon } from "lucide-react";
import { useReports, useUsers, useUploadReport, useDeleteReport } from "@/hooks/useData";
import { useAuth } from "@/context/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { MoneyPanel, DataList, DataRow, BentoGrid, bento } from "@/components/money/Money";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format";
import { plainDate } from "@/lib/money";
import { apiUrl } from "@/lib/api";
import { impactFeedback } from "@/lib/haptics";

export default function Reports() {
  const { user } = useAuth();
  const { data: reports, isLoading, isError, error, refetch } = useReports();
  const { data: users } = useUsers();
  const uploadReport = useUploadReport();
  const deleteReport = useDeleteReport();

  const canUpload = user != null && ["admin", "sales", "project_manager"].includes(user.role);
  const canDelete = user != null && ["admin", "project_manager"].includes(user.role);
  const isStaff = user != null && ["admin", "sales", "project_manager"].includes(user.role);
  const clients = (users ?? []).filter((u) => u.role === "client");

  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [category, setCategory] = useState("");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);

  function openUpload() {
    setClientId(clients[0]?.id ?? "");
    setCategory("");
    setName("");
    setFile(null);
    setOpen(true);
  }

  function submit() {
    if (!clientId) {
      toast.error("Select a client");
      return;
    }
    if (!file) {
      toast.error("Choose a file to upload");
      return;
    }
    const formData = new FormData();
    formData.append("clientId", clientId);
    formData.append("category", category || "General");
    if (name.trim()) formData.append("name", name.trim());
    formData.append("file", file);

    uploadReport.mutate(formData, {
      onSuccess: () => {
        toast.success("Report uploaded");
        setOpen(false);
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to upload report"),
    });
  }

  function remove(id: string, reportName: string) {
    if (!window.confirm(`Delete "${reportName}"? This cannot be undone.`)) return;

    // Confirmed, and this one does not come back. The heavy tap marks the

    // moment the decision was actually taken.

    impactFeedback();
    deleteReport.mutate(id, {
      onSuccess: () => toast.success("Report deleted"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete report"),
    });
  }

  const clientName = (id: string) => users?.find((u) => u.id === id)?.name ?? id;

  return (
    <BentoGrid className="mx-auto w-full max-w-6xl">
      <div className={bento(4)}>
        <PageHeader
          title="Documents"
          description="Summaries, audits, and anything else we have shared with you."
          actions={
            canUpload ? (
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger render={<Button onClick={openUpload} className="h-10 px-4 gap-2 font-medium" />}>
                  <Plus className="size-4" /> Upload
                </DialogTrigger>
                <DialogContent
                  showCloseButton={false}
                  className="sm:max-w-md p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
                >
                  <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                          <UploadIcon className="size-5" />
                        </div>
                        <div>
                          <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">Upload Report</DialogTitle>
                          <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                            Share a document with a client.
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

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Category</Label>
                        <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Performance" className="bg-background/50 border-border/60" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Display Name</Label>
                        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to file name" className="bg-background/50 border-border/60" />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">File * (max 15MB, 4MB without Drive configured)</Label>
                      <Input
                        type="file"
                        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                        className="bg-background/50 border-border/60"
                      />
                    </div>
                  </div>

                  <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-2.5 rounded-b-2xl">
                    <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground" />}>
                      Cancel
                    </DialogClose>
                    <Button
                      onClick={submit}
                      disabled={uploadReport.isPending || !file || !clientId}
                      className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs"
                    >
                      {uploadReport.isPending ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Uploading…
                        </>
                      ) : (
                        "Upload"
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
      ) : !reports || reports.length === 0 ? (
        <div className={bento(4)}>
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="Anything we prepare for you will appear here, ready to open."
          />
        </div>
      ) : (
        <MoneyPanel className={bento(4)} title="Ready to read" subtitle={`${reports.length} in total`}>
          <DataList>
            {reports.map((r) => (
              <DataRow
                key={r.id}
                title={r.name}
                meta={[
                  r.category,
                  isStaff ? clientName(r.clientId) : null,
                  formatBytes(r.sizeBytes),
                  `Added ${plainDate(r.createdAt)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                action={
                  <div className="flex shrink-0 items-center gap-1.5">
                    {/* Open shows it; Download saves it. They were one link
                        before, and because the server always sent
                        `attachment` the new tab downloaded and shut itself --
                        which looks like nothing happened. */}
                    {/* Opens inside the portal rather than handing the file to
                        the browser, which downloads it for anyone whose Chrome
                        is set to "download PDFs instead of opening them". */}
                    <Link
                      to={`/portal/reports/${r.id}`}
                      aria-label={`Open ${r.name}`}
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" }),
                        "h-9 gap-1.5 px-3 coarse:h-10",
                      )}
                    >
                      <Eye aria-hidden className="size-3.5" />
                      Open
                    </Link>
                    <a
                      href={apiUrl(`/reports/${r.id}/download`)}
                      download={r.name}
                      aria-label={`Download ${r.name}`}
                      title="Download"
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "icon-sm" }),
                        "size-9 text-muted-foreground hover:text-foreground coarse:size-10",
                      )}
                    >
                      <Download aria-hidden className="size-4" />
                    </a>
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${r.name}`}
                        title="Delete"
                        className="size-9 text-destructive/80 hover:bg-destructive/10 hover:text-destructive coarse:size-10"
                        onClick={() => remove(r.id, r.name)}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    )}
                  </div>
                }
              />
            ))}
          </DataList>
        </MoneyPanel>
      )}
    </BentoGrid>
  );
}
