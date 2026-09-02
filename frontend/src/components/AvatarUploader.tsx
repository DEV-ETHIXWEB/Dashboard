import { useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/UserAvatar";
import { useRemoveAvatar, useUploadAvatar } from "@/hooks/useProfile";
import { ACCEPT_ATTRIBUTE, AvatarError } from "@/lib/avatar";
import { impactFeedback, tapFeedback } from "@/lib/haptics";

/**
 * The picture, and the two things you can do to it.
 *
 * A hidden file input behind a real button rather than a styled `<input>`: the
 * native control cannot be made to match anything else on this page, and a
 * button that opens the picker keeps the keyboard and screen-reader behaviour
 * that the input already has.
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

  const busy = upload.isPending || remove.isPending;
  const hasPicture = Boolean(user.hasAvatar || user.avatarUpdatedAt);

  async function pick(file: File | undefined) {
    if (!file) return;
    tapFeedback();
    try {
      await upload.mutateAsync({ userId: user.id, file });
      toast.success("Profile picture updated");
    } catch (err) {
      // An AvatarError happened in this browser before anything was sent, and
      // already says what to do about it. Anything else came from the server,
      // which has its own words for the same job.
      toast.error(
        err instanceof AvatarError || err instanceof Error
          ? err.message
          : "That picture could not be uploaded",
      );
    } finally {
      // Cleared either way, so picking the same file twice fires a change event
      // the second time.
      if (inputRef.current) inputRef.current.value = "";
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
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="relative">
        <UserAvatar user={user} className="size-20 ring-1 ring-border/80" />
        {busy && (
          <div className="absolute inset-0 grid place-items-center rounded-full bg-background/70">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-col items-center gap-2 sm:items-start">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            className="sr-only"
            onChange={(e) => pick(e.target.files?.[0])}
          />

          <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="gap-1.5"
            >
              <Camera className="size-3.5" />
              {hasPicture ? "Replace" : "Upload"}
            </Button>

            {hasPicture && !confirmingRemove && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingRemove(true)}
                className="gap-1.5 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
                Remove
              </Button>
            )}

            {confirmingRemove && (
              <span className="flex items-center gap-1.5">
                <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={doRemove}>
                  {remove.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Remove it"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmingRemove(false)}
                >
                  Keep
                </Button>
              </span>
            )}
          </div>

          <p className="text-center text-xs text-muted-foreground sm:text-left">
            PNG, JPEG or WebP. Cropped to a square and scaled down here before it is sent.
          </p>
        </div>
      )}
    </div>
  );
}
