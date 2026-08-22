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
  X,
} from "lucide-react";
import { TICKET_PRIORITIES, type TicketPriority } from "@/lib/tickets";
import { useAuth } from "@/context/AuthContext";
import { useCreateTicket, useUsers } from "@/hooks/useData";
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

  function submit() {
    if (!subject.trim()) {
      toast.error("Subject is required");
      return;
    }
    if (isStaff && !clientId) {
      toast.error("Select a client");
      return;
    }
    createTicket.mutate(
      { subject, category, description, priority, ...(isStaff ? { clientId } : {}) },
      {
        onSuccess: () => {
          toast.success("Ticket created - the team has been alerted");
          setOpen?.(false);
          setSubject("");
          setDescription("");
          setClientId("");
          setPriority("Normal");
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to create ticket"),
      },
    );
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
                    onClick={() => setCategory(cat.name)}
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
