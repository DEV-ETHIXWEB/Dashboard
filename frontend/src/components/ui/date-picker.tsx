import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, CalendarDays, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toLocalISO, parseLocalISO } from "@/lib/format";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function startOfToday(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  placeholder?: string;
  clearable?: boolean;
  id?: string;
  className?: string;
  disabled?: boolean;
}

const PANEL_W = 286;
const PANEL_H = 340;

export function DatePicker({
  value,
  onChange,
  min,
  placeholder = "Select a date",
  clearable = true,
  id,
  className,
  disabled,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const selected = useMemo(() => parseLocalISO(value), [value]);
  const minDate = useMemo(() => (min ? parseLocalISO(min) : null), [min]);

  const [cursor, setCursor] = useState<Date>(() => selected ?? startOfToday());
  useEffect(() => {
    if (selected) setCursor(new Date(selected.getFullYear(), selected.getMonth(), 1));
  }, [selected]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const top = below < PANEL_H + 12 && r.top > PANEL_H + 12 ? r.top - PANEL_H - 8 : r.bottom + 8;
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - PANEL_W - 8));
      setPos({ top, left });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const grid = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells: { date: Date; outside: boolean }[] = [];
    for (let i = 0; i < lead; i++) {
      cells.push({ date: new Date(year, month, i - lead + 1), outside: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(year, month, d), outside: false });
    }
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1].date;
      cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), outside: true });
    }
    return cells;
  }, [cursor]);

  const today = startOfToday();
  const isDisabled = (d: Date) => Boolean(minDate && d < minDate);

  function select(d: Date) {
    if (isDisabled(d)) return;
    onChange(toLocalISO(d));
    setOpen(false);
  }

  const label = selected
    ? selected.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })
    : placeholder;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 text-left text-sm outline-none transition-colors",
          "hover:border-primary/50 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20",
          "disabled:pointer-events-none disabled:opacity-50",
          open && "border-primary ring-2 ring-primary/20",
        )}
      >
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
        <span className={cn("flex-1 truncate", !selected && "text-muted-foreground")}>{label}</span>
        {clearable && selected && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear date"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </span>
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Choose a date"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: PANEL_W }}
          className="z-[60] rounded-xl border border-border/70 bg-card p-3 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-150"
        >
          <div className="mb-2 flex items-center justify-between gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Previous month"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            >
              <ChevronLeft className="size-4" />
            </Button>

            <div className="flex items-center gap-1.5">
              <select
                aria-label="Month"
                value={cursor.getMonth()}
                onChange={(e) => setCursor(new Date(cursor.getFullYear(), Number(e.target.value), 1))}
                className="cursor-pointer rounded-md bg-transparent px-1 py-0.5 text-sm font-semibold text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i} className="bg-card text-foreground">
                    {m}
                  </option>
                ))}
              </select>
              <select
                aria-label="Year"
                value={cursor.getFullYear()}
                onChange={(e) => setCursor(new Date(Number(e.target.value), cursor.getMonth(), 1))}
                className="cursor-pointer rounded-md bg-transparent px-1 py-0.5 text-sm font-semibold text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                {Array.from({ length: 12 }, (_, i) => today.getFullYear() - 1 + i).map((y) => (
                  <option key={y} value={y} className="bg-card text-foreground">
                    {y}
                  </option>
                ))}
              </select>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Next month"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 pb-1">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="flex h-7 items-center justify-center t-label text-muted-foreground"
              >
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {grid.map(({ date, outside }) => {
              const isSelected = selected != null && sameDay(date, selected);
              const isToday = sameDay(date, today);
              const off = isDisabled(date);
              return (
                <button
                  key={`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`}
                  type="button"
                  disabled={off}
                  aria-current={isToday ? "date" : undefined}
                  aria-selected={isSelected}
                  onClick={() => select(date)}
                  className={cn(
                    "relative flex h-8 items-center justify-center rounded-md text-sm tabular-nums transition-colors outline-none",
                    "focus-visible:ring-2 focus-visible:ring-primary/40",
                    off && "cursor-not-allowed text-muted-foreground/30",
                    !off && outside && "text-muted-foreground/45 hover:bg-muted/60",
                    !off && !outside && "text-foreground hover:bg-muted",
                    isSelected && "bg-primary font-semibold text-primary-foreground hover:bg-primary shadow-xs",
                  )}
                >
                  {date.getDate()}
                  {isToday && !isSelected && (
                    <span aria-hidden className="absolute bottom-1 size-1 rounded-full bg-primary" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-2">
            {clearable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                Clear
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-primary hover:text-primary"
              disabled={isDisabled(today)}
              onClick={() => select(today)}
            >
              Today
            </Button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
