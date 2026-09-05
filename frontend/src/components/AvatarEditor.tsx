import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  clampTransform,
  drawAvatar,
  exportAvatar,
  IDENTITY_TRANSFORM,
  MAX_ZOOM,
  type AvatarTransform,
} from "@/lib/avatar";
import { tapFeedback } from "@/lib/haptics";

/** The preview square, in CSS pixels. Big enough to judge a face by. */
const VIEWPORT = 260;

/**
 * Framing a picture before it becomes an avatar.
 *
 * The old behaviour took a centred square and hoped -- fine for a portrait, bad
 * for anything where the subject is off to one side, and there was no way to
 * tell it was wrong until the picture was already your face on every screen in
 * the app.
 *
 * What you see here is not an approximation of the result: the preview and the
 * upload are the same drawing function at two sizes (see lib/avatar.ts), so the
 * circle on screen is the crop, to the pixel.
 *
 * The square is drawn full-bleed with a circular cut-out over it rather than
 * clipping to the circle, because the corners are genuinely useful while you
 * drag -- they show what you are about to lose.
 */
export function AvatarEditor({
  image,
  sourceType,
  open,
  busy,
  onCancel,
  onSave,
}: {
  image: HTMLImageElement | null;
  sourceType: string;
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (blob: Blob) => void;
}) {
  // The canvas is held in state, not a ref, so the effects below re-run when
  // the element actually attaches. With a ref they ran once -- on the render
  // where `open` and `image` both flipped -- which is the render where the
  // dialog is still mounting and `ref.current` is not yet the canvas. The
  // picture never got drawn and the editor opened on an empty circle.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [transform, setTransform] = useState<AvatarTransform>(IDENTITY_TRANSFORM);
  const [exporting, setExporting] = useState(false);

  // Every fresh picture starts square-on and centred.
  useEffect(() => {
    if (image) setTransform(IDENTITY_TRANSFORM);
  }, [image]);

  const nudge = useCallback(
    (change: Partial<AvatarTransform>) => {
      if (!image) return;
      setTransform((t) => clampTransform(image, { ...t, ...change }));
    },
    [image],
  );

  // Repaint whenever the framing or the picture changes. Drawn at device
  // resolution so the preview is as sharp as the export it is standing in for.
  useEffect(() => {
    if (!canvas || !image) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const px = Math.round(VIEWPORT * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext("2d");
    if (ctx) drawAvatar(ctx, image, transform, px);
  }, [canvas, image, transform]);

  // Dragging to reposition, and pinching to zoom. Pointer events cover the
  // mouse, the trackpad and the thumb without three separate code paths.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch.current = null;
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const previous = pointers.current.get(e.pointerId);
    if (!previous) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const points = [...pointers.current.values()];

    if (points.length >= 2) {
      const [a, b] = points;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (!pinch.current) {
        pinch.current = { distance, scale: transform.scale };
      } else if (pinch.current.distance > 0) {
        nudge({ scale: pinch.current.scale * (distance / pinch.current.distance) });
      }
      return;
    }

    // Offsets are fractions of the square, so a pixel of travel is a pixel of
    // travel at any preview size.
    nudge({
      ox: transform.ox + (e.clientX - previous.x) / VIEWPORT,
      oy: transform.oy + (e.clientY - previous.y) / VIEWPORT,
    });
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }

  // Non-passive, because a wheel over the picture is a zoom and must not also
  // scroll the dialog behind it.
  useEffect(() => {
    if (!canvas || !image) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setTransform((t) => clampTransform(image, { ...t, scale: t.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1) }));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [canvas, image]);

  async function save() {
    if (!image) return;
    setExporting(true);
    try {
      onSave(await exportAvatar(image, transform, sourceType));
    } finally {
      setExporting(false);
    }
  }

  const working = busy || exporting;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !working && onCancel()}>
      <DialogContent className="sm:max-w-[22rem]">
        <DialogHeader>
          <DialogTitle>Position your picture</DialogTitle>
          <DialogDescription>
            Drag to move, pinch or scroll to zoom. What is inside the circle is what people see.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          <div
            className="relative touch-none overflow-hidden rounded-2xl bg-muted/40"
            style={{ width: VIEWPORT, height: VIEWPORT }}
          >
            <canvas
              ref={setCanvas}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              aria-label="Drag to reposition your picture"
              className="block h-full w-full cursor-grab touch-none active:cursor-grabbing"
              style={{ width: VIEWPORT, height: VIEWPORT }}
            />
            {/* The mask, in one element: a circle inscribed in the square whose
                outward box-shadow is large enough to cover every corner, so the
                area outside the crop dims and the area inside stays untouched.
                The parent's overflow-hidden trims the shadow back to the square.
                `pointer-events-none` is what keeps the drag working through it. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full border border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
            />
          </div>

          <div className="flex w-full items-center gap-3">
            <ZoomOut aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="range"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={transform.scale}
              disabled={working}
              aria-label="Zoom"
              onChange={(e) => nudge({ scale: Number(e.target.value) })}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
            <ZoomIn aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={working}
              onClick={() => {
                tapFeedback();
                nudge({ rotation: (transform.rotation + 90) % 360 });
              }}
              className="gap-1.5"
            >
              <RotateCw className="size-3.5" />
              Rotate
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={working}
              onClick={() => setTransform(IDENTITY_TRANSFORM)}
              className="text-muted-foreground"
            >
              Reset
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={working} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={working || !image} onClick={save} className="gap-1.5">
            {working && <Loader2 className="size-4 animate-spin" />}
            Save picture
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
