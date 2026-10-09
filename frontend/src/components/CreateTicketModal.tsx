import { useState } from "react";
import { toast } from "sonner";
import {
  MessageSquarePlus,
  Globe,
  Smartphone,
  Megaphone,
  CreditCard,
  HelpCircle,
  Send,
  User,
  Sparkles,
  Loader2,
  FileText,
  Flame,
  Siren,
  X,
} from "lucide-react";
import { TICKET_PRIORITIES, type TicketPriority } from "@/lib/tickets";
import { useAuth } from "@/context/AuthContext";
import { useCreateTicket, useUsers } from "@/hooks/useData";
import { useNavigate } from "react-router-dom";
import { ApiError } from "@/lib/api";
import { AllowancePanel, type RequestBlock } from "@/components/plans/AllowancePanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const CATEGORIES = [
  { name: "Website", icon: Globe, description: "Bugs, layout, or content updates" },
  { name: "Mobile App", icon: Smartphone, description: "iOS or Android app issues" },
  { name: "Marketing", icon: Megaphone, description: "SEO, campaigns, or social media" },
  // Its own category rather than a Website bug. An outage is the one thing
  // every plan can always report -- a client whose site is down must be able
  // to reach us whatever they pay -- and it must never eat one of a Managed
  // client's two monthly updates. Both of those rules key off this name; see
  // NON_UPDATE_CATEGORIES in lib/plans.js.
  { name: "Site down", icon: Siren, description: "Your site is offline or unreachable" },
  { name: "Billing", icon: CreditCard, description: "Invoices, payments, or subscriptions" },
  { name: "Other", icon: HelpCircle, description: "General inquiries & support" },
];

/** Mirrors RESPONSE_HOURS in utils/ticketIntake.js. */
const RESPONSE_TARGET: Record<TicketPriority, string> = {
  Urgent: "within 1 hour",
  High: "within 4 hours",
  Normal: "within 8 hours",
  Low: "within 24 hours",
};

const QUICK_TEMPLATES = [
  "CTA button not working",
  "Add landing page section",
  "Invoice update request",
  "Mobile layout issue",
];

export function CreateTicketModal({
  open,
  onOpenChange,
  trigger,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
}) {
  const { user } = useAuth();
  const { data: users } = useUsers();
  const createTicket = useCreateTicket();
  const navigate = useNavigate();

  const isStaff = user && ["admin", "sales", "project_manager", "employee"].includes(user.role);
  const clients = (users ?? []).filter((u) => u.role === "client");

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = isControlled ? onOpenChange : setInternalOpen;

  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("Website");
  const [description, setDescription] = useState("");
  const [clientId, setClientId] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("Normal");

  /**
   * What the plan said when it would not take this request as it stands.
   *
   * Held in state rather than thrown away, because the whole point is that the
   * form stays exactly as the client left it while they decide. Nothing they
   * typed is cleared on a refusal -- only on a send that actually succeeded.
   */
  const [block, setBlock] = useState<RequestBlock | null>(null);

  function send(extra?: { acceptExtraCharge?: boolean; queueForNextPeriod?: boolean }) {
    if (!subject.trim()) {
      toast.error("Subject is required");
      return;
    }
    if (isStaff && !clientId) {
      toast.error("Select a client");
      return;
    }

    createTicket.mutate(
      { subject, category, description, priority, ...(isStaff ? { clientId } : {}), ...extra },
      {
        onSuccess: (result) => {
          toast.success(
            result.queued
              ? result.message || "Saved for when your next updates unlock"
              : result.chargedAsExtra
                ? "Sent. We will quote this one before any work starts."
                : "Ticket created - the team has been alerted",
          );
          setOpen?.(false);
          setBlock(null);
          setSubject("");
          setDescription("");
          setClientId("");
          setPriority("Normal");
        },
        onError: (err) => {
          // A plan limit is a decision for the client to make, not a failure.
          // It comes back with everything the panel needs to offer the three
          // ways forward, and the form keeps every word they typed.
          const payload = err instanceof ApiError ? err.payload : null;
          if (payload?.upgradeRequired) {
            setBlock({
              error: String(payload.error ?? err.message),
              reason: String(payload.reason ?? "allowance_used"),
              recommended: (payload.recommended as RequestBlock["recommended"]) ?? null,
              resetsAt: (payload.resetsAt as string | null) ?? null,
              chargeable: Boolean(payload.chargeable),
            });
            return;
          }
          toast.error(err instanceof Error ? err.message : "Failed to create ticket");
        },
      },
    );
  }

  const submit = () => send();

  // Changing the category after being turned away clears the panel: a client
  // who switches from a change request to "Site down" is asking something the
  // plan does allow, and leaving the refusal on screen would say otherwise.
  function chooseCategory(name: string) {
    setCategory(name);
    setBlock(null);
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-3xl p-0 gap-0 overflow-hidden border border-border/60 shadow-2xl rounded-2xl bg-card"
      >
        <div className="relative p-6 pb-4 border-b border-border/40 bg-gradient-to-br from-primary/10 via-background to-background">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-xs">
                <MessageSquarePlus className="size-5.5" />
              </div>
              <div>
                <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
                  Ask us something
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Describe your request below and our team will get right on it.
                </DialogDescription>
              </div>
            </div>
            <DialogClose className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </div>
        </div>

        {/* Two columns: what the request is on the left, how to route it on the right. */}
        <div className="no-scrollbar grid max-h-[72svh] gap-5 overflow-y-auto overscroll-contain p-6 md:grid-cols-2">
          <div className="space-y-5">
          {isStaff && (
            <div className="space-y-2">
              <Label className="text-xs font-medium text-foreground/90 flex items-center gap-1.5">
                <User className="size-3.5 text-primary" /> Client <span className="text-destructive">*</span>
              </Label>
              <Select
                items={Object.fromEntries(clients.map((c) => [c.id, c.company || c.name]))}
                value={clientId}
                onValueChange={(v) => setClientId(v ?? "")}
              >
                <SelectTrigger className="h-10 w-full bg-background/50 border-border/60 focus:ring-primary/40">
                  <SelectValue placeholder="Select client account..." />
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
          )}

          <div className="space-y-2">
            <Label htmlFor="subject" className="text-xs font-medium text-foreground/90 flex items-center gap-1.5">
              <FileText className="size-3.5 text-primary" /> What is it about? <span className="text-destructive">*</span>
            </Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Briefly describe what you need..."
              className="h-10 bg-background/50 border-border/60 focus-visible:ring-primary/40 text-sm"
            />

            <div className="pt-1 flex flex-wrap gap-1.5">
              {QUICK_TEMPLATES.map((tmpl) => (
                <button
                  key={tmpl}
                  type="button"
                  onClick={() => setSubject(tmpl)}
                  className="text-[11px] px-2.5 py-1 rounded-full bg-muted/60 hover:bg-primary/10 hover:text-primary border border-border/40 text-muted-foreground transition-all duration-150 flex items-center gap-1 cursor-pointer"
                >
                  <Sparkles className="size-2.5 text-primary/70" />
                  {tmpl}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="description" className="text-xs font-medium text-foreground/90">
                Tell us more
              </Label>
              <span className="text-[11px] text-muted-foreground">{description.length} characters</span>
            </div>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add details, steps to reproduce, or context..."
              rows={6}
              className="bg-background/50 border-border/60 focus-visible:ring-primary/40 text-sm resize-none"
            />
          </div>
          </div>

          <div className="space-y-5">
          <div className="space-y-2">
            <Label className="text-xs font-medium text-foreground/90">Category</Label>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORIES.map((cat) => {
                const Icon = cat.icon;
                const isSelected = category === cat.name;
                return (
                  <button
                    key={cat.name}
                    type="button"
                    onClick={() => chooseCategory(cat.name)}
                    className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-left text-xs font-medium transition-all duration-150 cursor-pointer ${
                      isSelected
                        ? "border-primary bg-primary/10 text-primary shadow-xs ring-1 ring-primary/30"
                        : "border-border/60 bg-background/40 hover:bg-muted/70 hover:border-border text-foreground/80"
                    }`}
                  >
                    <Icon className={`size-4 shrink-0 ${isSelected ? "text-primary" : "text-muted-foreground"}`} />
                    <span className="truncate">{cat.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium text-foreground/90 flex items-center gap-1.5">
              <Flame className="size-3.5 text-primary" /> How urgent is it?
            </Label>
            <div className="grid grid-cols-4 gap-2">
              {TICKET_PRIORITIES.map((p) => {
                const isSelected = priority === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`rounded-xl border p-2 text-xs font-medium transition-all duration-150 cursor-pointer ${
                      isSelected
                        ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/30"
                        : "border-border/60 bg-background/40 text-foreground/80 hover:border-border hover:bg-muted/70"
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Sets how fast we owe you a first reply: {RESPONSE_TARGET[priority]}.
            </p>
          </div>
          </div>
        </div>

        {/* Sits between the form and the send button, so it is the last thing
            read before deciding -- and so the form above it is visibly intact,
            which is the reassurance that matters here. */}
        {block && (
          <div className="px-6 pb-4">
            <AllowancePanel
              block={block}
              busy={createTicket.isPending}
              onUpgrade={(plan) => {
                setOpen?.(false);
                navigate(`/portal/billing/plans?plan=${plan}`);
              }}
              onPayExtra={() => send({ acceptExtraCharge: true })}
              onQueue={() => send({ queueForNextPeriod: true })}
            />
          </div>
        )}

        <DialogFooter className="m-0 px-6 py-4 bg-muted/30 border-t border-border/40 flex flex-row items-center justify-end gap-3 rounded-b-2xl sm:justify-end">
          <DialogClose render={<Button variant="ghost" className="h-9 text-xs px-3.5 text-muted-foreground hover:text-foreground cursor-pointer" />}>
            Cancel
          </DialogClose>
          <Button
            onClick={submit}
            disabled={createTicket.isPending || !subject.trim()}
            className="h-9 px-4 text-xs font-medium gap-1.5 shadow-xs transition-all duration-150 cursor-pointer"
          >
            {createTicket.isPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Send className="size-3.5" />
                Send request
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
