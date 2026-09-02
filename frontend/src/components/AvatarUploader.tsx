import { useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { AvatarEditor } from "@/components/AvatarEditor";
import { UserAvatar } from "@/components/UserAvatar";
import { useRemoveAvatar, useUploadAvatar } from "@/hooks/useProfile";
import { ACCEPT_ATTRIBUTE, AvatarError, loadImageFile, type LoadedImage } from "@/lib/avatar";
import { impactFeedback, tapFeedback } from "@/lib/haptics";

/**
 * The picture, and the two things you can do to it.
 *
 * The camera sits on the picture rather than beside it: the thing you press is
 * the thing you are changing, which is how every phone has done this for a
 * decade, and it takes a button and a paragraph of instructions out of the
 * page. The whole circle is the target, not just the badge -- a 20px badge is
 * a miss waiting to happen on a phone, so the badge is the affordance and the
 * circle is the hit box.
 *
 * A hidden file input behind it rather than a styled `<input>`: the native
 * control cannot be made to match anything else on this page, and a button that
 * opens the picker keeps the keyboard and screen-reader behaviour the input
 * already has.
 *
 * Picking does not upload. It opens the editor (components/AvatarEditor.tsx),
 * because the crop used to be chosen for you and there was no way to find out
 * it had chosen wrongly until it was already your face across the app.
 *
 * Removing is a confirmed action because it cannot be undone -- the bytes are
 * gone from the server, and the person would have to find the original again.
 */
export function AvatarUploader({
  user,
  canEdit,
}: {
  user: { id: string; name: string; hasAvatar?: boolean; avatarUpdatedAt?: number | null };
  canEdit: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadAvatar();
  const remove = useRemoveAvatar();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [editing, setEditing] = useState<{ loaded: LoadedImage; type: string } | null>(null);

  const busy = upload.isPending || remove.isPending;
  const hasPicture = Boolean(user.hasAvatar || user.avatarUpdatedAt);

  /** Cleared either way, so picking the same file twice still fires a change. */
  function resetInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  /** Close the editor and let go of the decoded picture behind it. */
  function closeEditor() {
    setEditing((current) => {
      current?.loaded.release();
      return null;
    });
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    tapFeedback();
    try {
      // Decoded here so an unusable file is refused before somebody spends time
      // framing it -- and so the editor is handed an image, not a promise.
      const loaded = await loadImageFile(file);
      setEditing((previous) => {
        // Picking twice without saving: the one being replaced is dropped here
        // rather than left holding its object URL for the life of the page.
        previous?.loaded.release();
        return { loaded, type: file.type };
      });
    } catch (err) {
      toast.error(
        err instanceof AvatarError || err instanceof Error
          ? err.message
          : "That picture could not be opened",
      );
    } finally {
      resetInput();
    }
  }

  async function saveCrop(blob: Blob) {
    try {
      await upload.mutateAsync({ userId: user.id, blob });
      closeEditor();
      toast.success("Profile picture updated");
    } catch (err) {
      // Anything reaching here came from the server, which has its own words.
      // The editor stays open and still holds the picture, so a failed upload
      // is one more tap rather than choosing and framing the photo again.
      toast.error(err instanceof Error ? err.message : "That picture could not be uploaded");
    }
  }

  async function doRemove() {
    impactFeedback();
    try {
      await remove.mutateAsync(user.id);
      setConfirmingRemove(false);
      toast.success("Profile picture removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That picture could not be removed");
    }
  }

  return (
    // A narrow column, not a row. The uploader used to put a button and a line
    // of instructions beside the picture, which stretched this block across the
    // card and pushed the name and email away from the face they belong to.
    // With the camera on the picture there is nothing left to put next to it.
    <div className="flex shrink-0 flex-col items-center gap-1">
      <div className="relative shrink-0">
        <UserAvatar user={user} className="size-20 ring-1 ring-border/80" />

        {canEdit && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              className="sr-only"
              onChange={(e) => pick(e.target.files?.[0])}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              aria-label={hasPicture ? "Replace profile picture" : "Upload a profile picture"}
              // The format rule lives here rather than as a line of body text
              // under the picture: it only matters at the moment of choosing,
              // and picking a GIF says so plainly enough on its own.
              title={`${hasPicture ? "Replace" : "Upload"} picture — PNG, JPEG or WebP`}
              className="focus-clear group absolute inset-0 grid touch-manipulation place-items-center rounded-full disabled:cursor-not-allowed"
            >
              {/* Dark wash over the picture so a white camera reads against a
                  light photograph. Always on for an empty avatar, where there
                  is nothing to see underneath and everything to explain. */}
              <span
                aria-hidden
                className={`absolute inset-0 rounded-full bg-black/45 transition-opacity ${
                  hasPicture ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : "opacity-100"
                }`}
              />
              <span
                aria-hidden
                className={`relative grid size-7 place-items-center rounded-full bg-white/15 text-white ring-1 ring-white/40 backdrop-blur-[1px] transition-opacity ${
                  hasPicture ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : "opacity-100"
                }`}
              >
                <Camera className="size-4" strokeWidth={2} />
              </span>
            </button>
          </>
        )}

        {busy && (
          <div className="absolute inset-0 grid place-items-center rounded-full bg-background/70">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        )}
      </div>

      {/* Removing needs a way in that does not involve picking a file first, so
          it stays visible -- but as a quiet line under the picture rather than
          a button competing with it, and only when there is something to
          remove. There is deliberately no "upload" text: the camera is the
          affordance, and a label repeating it is a label nobody needs twice. */}
      {canEdit && hasPicture && (
        <div className="flex h-6 items-center">
          {!confirmingRemove ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingRemove(true)}
              className="focus-clear inline-flex cursor-pointer items-center gap-1 rounded text-[11px] font-medium text-muted-foreground transition-colors hover:text-destructive"
            >
              <Trash2 aria-hidden className="size-3" />
              Remove
            </button>
          ) : (
            <span className="flex items-center gap-2 text-[11px] font-medium">
              <button
                type="button"
                disabled={busy}
                onClick={doRemove}
                className="focus-clear inline-flex cursor-pointer items-center gap-1 rounded text-destructive hover:underline"
              >
                {remove.isPending && <Loader2 aria-hidden className="size-3 animate-spin" />}
                Remove it
              </button>
              <span aria-hidden className="text-border">|</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingRemove(false)}
                className="focus-clear cursor-pointer rounded text-muted-foreground hover:text-foreground"
              >
                Keep
              </button>
            </span>
          )}
        </div>
      )}

      <AvatarEditor
        open={editing !== null}
        image={editing?.loaded.image ?? null}
        sourceType={editing?.type ?? "image/jpeg"}
        busy={upload.isPending}
        onCancel={closeEditor}
        onSave={saveCrop}
      />
    </div>
  );
}
