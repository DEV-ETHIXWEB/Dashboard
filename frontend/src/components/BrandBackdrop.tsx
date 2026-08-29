/**
 * The layered brand wash: colour blobs, a faint grid, and the spiderweb motif.
 *
 * Lifted out of the Login page so the boot splash can stand on the same
 * backdrop instead of a flat fill. Two copies of this markup would drift the
 * first time anyone retuned a blur radius.
 *
 * Every layer is absolutely positioned at a negative z-index, so the host only
 * has to be `relative` (or otherwise establish a stacking context) and supply
 * the base gradient -- `bg-gradient-to-b from-secondary/50 via-background
 * to-background` -- on its own container. Content in normal flow paints above
 * all of it without needing a z-index of its own.
 */
export function BrandBackdrop() {
  return (
    <>
      <div className="pointer-events-none absolute inset-0 -z-30 bg-[radial-gradient(circle_at_15%_20%,color-mix(in_oklch,var(--primary)_16%,transparent),transparent_45%),radial-gradient(circle_at_85%_15%,rgba(59,130,246,0.14),transparent_45%),radial-gradient(circle_at_50%_100%,rgba(168,85,247,0.12),transparent_50%)]" />
      <div className="absolute inset-0 -z-20 opacity-[0.07] pointer-events-none bg-[linear-gradient(to_right,color-mix(in_oklch,var(--foreground)_9%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--foreground)_9%,transparent)_1px,transparent_1px)] bg-[size:36px_36px] [mask-image:radial-gradient(ellipse_75%_65%_at_50%_40%,black,transparent)]" />

      <div className="absolute -top-28 -left-20 w-[480px] h-[480px] bg-primary/25 rounded-full blur-[140px] pointer-events-none -z-10 animate-[pulse_10s_ease-in-out_infinite]" />
      <div className="absolute top-12 -right-16 w-[440px] h-[440px] bg-rose-600/20 rounded-full blur-[130px] pointer-events-none -z-10 animate-[pulse_12s_ease-in-out_infinite]" />
      <div className="absolute bottom-8 left-[10%] w-[380px] h-[380px] bg-purple-600/15 rounded-full blur-[120px] pointer-events-none -z-10" />
      <div className="absolute -bottom-32 -right-12 w-[540px] h-[540px] bg-blue-600/15 rounded-full blur-[160px] pointer-events-none -z-10 animate-[pulse_8s_ease-in-out_infinite]" />

      <div
        className="pointer-events-none absolute -top-16 -right-16 w-[580px] h-[580px] bg-contain bg-no-repeat opacity-[0.08] dark:opacity-[0.12] -z-20 rotate-12"
        style={{ backgroundImage: "url('/spiderweb.svg')" }}
      />
      <div
        className="pointer-events-none absolute -bottom-24 -left-24 w-[640px] h-[640px] bg-contain bg-no-repeat opacity-[0.08] dark:opacity-[0.11] -z-20 -rotate-45"
        style={{ backgroundImage: "url('/spiderweb.svg')" }}
      />
      <div
        className="pointer-events-none absolute top-1/4 -left-32 w-[480px] h-[480px] bg-contain bg-no-repeat opacity-[0.06] dark:opacity-[0.09] -z-20 rotate-90"
        style={{ backgroundImage: "url('/spiderweb.svg')" }}
      />
      <div
        className="pointer-events-none absolute bottom-1/4 -right-28 w-[450px] h-[450px] bg-contain bg-no-repeat opacity-[0.06] dark:opacity-[0.09] -z-20 -rotate-15"
        style={{ backgroundImage: "url('/spiderweb.svg')" }}
      />
    </>
  );
}
