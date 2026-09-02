import { useMemo } from "react";
import { Clock } from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toLocalISO, parseLocalISO } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A moment, picked in the app's own vocabulary.
 *
 * `<input type="datetime-local">` is the obvious answer and the wrong one here:
 * the calendar it opens is drawn by the browser, in the browser's colours, with
 * the operating system's blue selection and its own idea of typography. Inside
 * a dialog that has been built to match everything else, it reads as a piece of
 * another application that has fallen into the page -- which is exactly what it
 * is.
 *
 * So the date half reuses the DatePicker this app already had, and the time
 * half is two of its own Selects. Nothing new is invented: the popover, the
 * focus ring, the selected-day pill and the dropdown all come from components
 * that were already on screen elsewhere.
 *
 * The value is epoch milliseconds, which is how every other timestamp in this
 * app travels. Both halves are read in the viewer's own timezone, so what the
 * server receives is a moment rather than a wall-clock reading it would have to
 * guess a zone for.
 */

/** Five-minute granularity: fine enough to schedule, coarse enough to scan. */
const MINUTE_STEP = 5;

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) =>
  String(i * MINUTE_STEP).padStart(2, "0"),
);

/** Records, because that is the shape this Select takes for its item map. */
const HOUR_ITEMS: Record<string, string> = Object.fromEntries(HOURS.map((h) => [h, h]));
const MINUTE_ITEMS: Record<string, string> = Object.fromEntries(MINUTES.map((m) => [m, m]));

/** Rounded down to the step, so the shown value is always one of the options. */
function snapMinute(minute: number): string {
  return String(Math.floor(minute / MINUTE_STEP) * MINUTE_STEP).padStart(2, "0");
}

export interface DateTimePickerProps {
  /** Epoch milliseconds, or null for nothing chosen yet. */
  value: number | null;
  onChange: (value: number | null) => void;
  /** Quick options above the fields, e.g. "In an hour". */
  presets?: { label: string; at: () => number }[];
  id?: string;
  className?: string;
  disabled?: boolean;
  minDate?: Date;
}

export function DateTimePicker({
  value,
  onChange,
  presets,
  id,
  className,
  disabled,
  minDate,
}: DateTimePickerProps) {
  const current = useMemo(() => (value ? new Date(value) : null), [value]);

  const dateValue = current ? toLocalISO(current) : "";
  const hour = current ? String(current.getHours()).padStart(2, "0") : "09";
  const minute = current ? snapMinute(current.getMinutes()) : "00";

  /** Rebuild the moment from whichever half just moved. */
  function emit(nextDate: string, nextHour: string, nextMinute: string) {
    if (!nextDate) return onChange(null);
    const day = parseLocalISO(nextDate);
    if (!day) return onChange(null);
    day.setHours(Number(nextHour), Number(nextMinute), 0, 0);
    onChange(day.getTime());
  }

  return (
    <div className={cn("space-y-2", className)}>
      {presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={disabled}
              onClick={() => onChange(preset.at())}
              className="focus-clear cursor-pointer rounded-lg border border-border/60 bg-background/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50 coarse:min-h-9"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <DatePicker
          id={id}
          value={dateValue}
          onChange={(next) => emit(next, hour, minute)}
          min={minDate ? toLocalISO(minDate) : undefined}
          clearable={false}
          disabled={disabled}
          placeholder="Pick a date"
          className="flex-1"
        />

        <div className="flex items-center gap-1.5">
          <Clock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Select
            items={HOUR_ITEMS}
            value={hour}
            disabled={disabled}
            onValueChange={(v) => emit(dateValue || toLocalISO(new Date()), v ?? hour, minute)}
          >
            <SelectTrigger aria-label="Hour" className="h-9 w-[4.25rem] border-border/60 bg-background/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h} value={h}>{h}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span aria-hidden className="text-sm font-medium text-muted-foreground">:</span>

          <Select
            items={MINUTE_ITEMS}
            value={minute}
            disabled={disabled}
            onValueChange={(v) => emit(dateValue || toLocalISO(new Date()), hour, v ?? minute)}
          >
            <SelectTrigger aria-label="Minute" className="h-9 w-[4.25rem] border-border/60 bg-background/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTES.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
