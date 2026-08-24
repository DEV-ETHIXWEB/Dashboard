import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type ThemeMode } from "@/hooks/useTheme";
import { selectionFeedback } from "@/lib/haptics";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Auto", icon: Monitor },
];

export function ThemeSwitch({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn("skeu-well grid grid-cols-3 gap-1 rounded-xl p-1", className)}
    >
      {OPTIONS.map((opt) => {
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              if (!active) selectionFeedback();
              setTheme(opt.value);
            }}
            className={cn(
              // min-w-0 so a long label shortens the key rather than widening
              // the track past the sidebar.
              "focus-clear flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg text-xs transition-[box-shadow,transform,color] duration-150",
              active
                ? "skeu-key font-medium text-foreground"
                : "skeu-key-idle font-normal text-muted-foreground hover:text-foreground",
            )}
          >
            <opt.icon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
