import { useEffect } from "react";

/**
 * The E draws as one line, splits into three bars, then THIXWEB slides in
 * behind it.
 *
 * The mark sits directly on whatever is behind it -- no panel, no frame. It
 * used to animate its own black/white/red ground, which meant the wordmark
 * read as a card dropped on the page rather than as the page itself. The
 * letters are white throughout, so this expects to be placed over a dark
 * backdrop (see BootSplash in App.tsx).
 *
 * Geometry is measured off public/ethixweb.png (422 x 63), so the bars land
 * on the exact pixels the artwork has them.
 *
 * The three beats are timed to run back to back and then stop. An earlier
 * version held for nearly two seconds after the wordmark had landed, because
 * the splash waited on DUR_MS while the last keyframe finished at 56% of it --
 * a finished logo being stared at is not a loading state.
 */
const DUR_MS = 3000;
const DUR = `${DUR_MS}ms`;

export function LogoBuildAnimation({ onComplete }: { onComplete?: () => void } = {}) {
  useEffect(() => {
    if (!onComplete) return;
    // A timer, not animationend: five animated elements finish at slightly
    // different times, so animationend would fire once per element rather
    // than once for the whole build. Reduced-motion turns the CSS off
    // entirely, so that viewer gets a short, fixed hold instead of a wait for
    // an animation that will never end.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setTimeout(onComplete, reduced ? 600 : DUR_MS);
    return () => window.clearTimeout(id);
  }, [onComplete]);

  return (
    <div
      className="relative w-[min(70vw,460px)]"
      style={{ ["--ew-dur" as string]: DUR }}
    >
      {/*
        One clock, three beats, expressed as percentages of DUR_MS:

          0 -> 25%    the middle bar draws itself
          25 -> 50%   it splits: one bar rises, one falls
          53 -> 87%   the wordmark wipes and slides in behind them
          87 -> 100%  a short settle, so the build ends rather than stops

        The top and bottom bars sit at scaleX(0) until the draw finishes.
        They are stacked on the middle bar at that moment, so without it the
        line would appear at full width instantly instead of being drawn.
      */}
      <style>{`
        @keyframes ew-draw {
          0%,  5%     { transform: scaleX(0); }
          25%, 100%   { transform: scaleX(1); }
        }
        @keyframes ew-splitUp {
          0%,  24.9%  { transform: translateY(277.8%) scaleX(0); }
          25%         { transform: translateY(277.8%) scaleX(1); }
          50%, 100%   { transform: translateY(0)      scaleX(1); }
        }
        @keyframes ew-splitDown {
          0%,  24.9%  { transform: translateY(-266.7%) scaleX(0); }
          25%         { transform: translateY(-266.7%) scaleX(1); }
          50%, 100%   { transform: translateY(0)       scaleX(1); }
        }
        @keyframes ew-wipe {
          0%,  53.3%  { clip-path: inset(0 89.81% 0 10.19%); }
          86.7%, 100% { clip-path: inset(0 0      0 10.19%); }
        }
        @keyframes ew-slide {
          0%,  53.3%  { transform: translateX(-5%); }
          86.7%, 100% { transform: translateX(0); }
        }
        .ew-bar-mid { animation: ew-draw var(--ew-dur) linear forwards; }
        .ew-bar-top { animation: ew-splitUp var(--ew-dur) linear forwards; }
        .ew-bar-bottom { animation: ew-splitDown var(--ew-dur) linear forwards; }
        .ew-word-clip { animation: ew-wipe var(--ew-dur) linear forwards; }
        .ew-word { animation: ew-slide var(--ew-dur) linear forwards; }
        /* Declared after the shorthands above so it wins on source order and
           replaces their \`linear\`. */
        .ew-bar { animation-timing-function: cubic-bezier(.22,1,.36,1); }
        .ew-word-clip, .ew-word { animation-timing-function: cubic-bezier(.33,.9,.2,1); }
        @media (prefers-reduced-motion: reduce) {
          .ew-bar, .ew-word-clip, .ew-word { animation: none !important; }
        }
      `}</style>
      <div className="relative aspect-[422/63] w-full text-white">
        <span className="ew-bar ew-bar-top absolute left-0 h-[14.2857%] w-[9.2417%] bg-current" style={{ top: "4.7619%" }} />
        <span className="ew-bar ew-bar-mid absolute left-0 h-[14.2857%] w-[9.2417%] bg-current" style={{ top: "44.4444%" }} />
        <span className="ew-bar ew-bar-bottom absolute left-0 h-[14.2857%] w-[9.2417%] bg-current" style={{ top: "82.5397%" }} />
        <span className="ew-word-clip absolute inset-0" style={{ clipPath: "inset(0 0 0 10.19%)" }}>
          <span
            className="ew-word absolute inset-0 bg-current"
            style={{
              WebkitMaskImage: "url(/ethixweb.png)",
              maskImage: "url(/ethixweb.png)",
              WebkitMaskSize: "100% 100%",
              maskSize: "100% 100%",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
            }}
          />
        </span>
      </div>
    </div>
  );
}
