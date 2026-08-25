import { useTheme } from "next-themes"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { successFeedback, errorFeedback, warningFeedback } from "@/lib/haptics"

/**
 * The toast is the app's universal "here is what just happened" channel, so it
 * is also the right place to give the thumb the matching confirmation. Wrapping
 * the singleton once, here, buzzes every success and every failure across all
 * ~two dozen call sites without any of them having to know -- and without a
 * plain tap on a mouse-driven desktop, where navigator.vibrate is a no-op.
 *
 * Guarded so React's double-invoke in development, or a hot reload, cannot wrap
 * the wrapper.
 */
type Wrappable = Record<string, ((...args: unknown[]) => unknown) | undefined> & { __haptics?: boolean }
const t = toast as unknown as Wrappable
if (!t.__haptics) {
  t.__haptics = true
  const wrap = (name: string, buzz: () => void) => {
    const original = t[name]
    if (typeof original !== "function") return
    try {
      t[name] = (...args: unknown[]) => {
        buzz()
        return original.apply(toast, args)
      }
    } catch {
      // A non-writable method just means no haptic on that variant; the toast
      // itself is untouched. Never let feedback wiring break the notification.
    }
  }
  wrap("success", successFeedback)
  wrap("error", errorFeedback)
  wrap("warning", warningFeedback)
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
