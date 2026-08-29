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
 */
const DUR_MS = 4400;
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
      <style>{`
        @keyframes ew-draw {
          0%,    4.1%  { transform: scaleX(0); }
          17.7%, 100%  { transform: scaleX(1); }
        }
        @keyframes ew-splitUp {
          0%,    17.6% { transform: translateY(277.8%) scaleX(0); }
          17.7%        { transform: translateY(277.8%) scaleX(1); }
          31.8%, 100%  { transform: translateY(0)      scaleX(1); }
        }
        @keyframes ew-splitDown {
          0%,    17.6% { transform: translateY(-266.7%) scaleX(0); }
          17.7%        { transform: translateY(-266.7%) scaleX(1); }
          31.8%, 100%  { transform: translateY(0)       scaleX(1); }
        }
        @keyframes ew-wipe {
          0%,    34.5% { clip-path: inset(0 89.81% 0 10.19%); }
          55.7%, 100%  { clip-path: inset(0 0      0 10.19%); }
        }
        @keyframes ew-slide {
          0%,    34.5% { transform: translateX(-5%); }
          55.7%, 100%  { transform: translateX(0); }
        }
        .ew-bar-mid { animation: ew-draw var(--ew-dur) linear forwards; }
        .ew-bar-top { animation: ew-splitUp var(--ew-dur) linear forwards; }
        .ew-bar-bottom { animation: ew-splitDown var(--ew-dur) linear forwards; }
        .ew-word-clip { animation: ew-wipe var(--ew-dur) linear forwards; }
        .ew-word { animation: ew-slide var(--ew-dur) linear forwards; }
        .ew-bar { animation-timing-function: cubic-bezier(.22,1,.36,1); }
        .ew-word-clip, .ew-word { animation-timing-function: cubic-bezier(.33,.9,.2,1); }
        @media (prefers-reduced-motion: reduce) {
          .ew-bar, .ew-word-clip, .ew-word { animation: none !important; }
        }
      `}</style>
      <div className="relative aspect-[422/63] w-full text-white">
        <span className="ew-bar absolute left-0 h-[14.2857%] w-[9.2417%] bg-current" style={{ top: "4.7619%" }} />
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
