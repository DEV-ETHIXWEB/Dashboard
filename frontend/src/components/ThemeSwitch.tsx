import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type ThemeMode } from "@/hooks/useTheme";
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
      className={cn("grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1", className)}
    >
      {OPTIONS.map((opt) => {
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(opt.value)}
            className={cn(
              "focus-clear flex h-8 items-center justify-center gap-1.5 rounded-md text-xs",
              active
                ? "bg-card font-medium text-foreground ring-1 ring-foreground/10"
                : "font-normal text-muted-foreground hover:text-foreground",
            )}
          >
            <opt.icon aria-hidden className="size-3.5 shrink-0" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
