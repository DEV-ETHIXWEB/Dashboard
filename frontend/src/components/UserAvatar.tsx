import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarUrl } from "@/lib/avatar";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One person's face, everywhere in the dashboard.
 *
 * Before this, six places each wrote their own `<Avatar><AvatarFallback>` pair
 * with their own initials call and their own tint. Adding pictures to all six
 * separately would have meant six chances to forget the fallback, and the
 * fallback is the case that happens most: most accounts have no picture, and
 * every one of them still has to look deliberate rather than broken.
 *
 * So the fallback is the default and the image is the enhancement. `hasAvatar`
 * decides whether a request is made at all -- an account with no picture never
 * fires a 404 -- and base-ui's Avatar falls back on its own if a request that
 * was made fails anyway.
 */
export function UserAvatar({
  user,
  size = "default",
  className,
  fallbackClassName,
}: {
  user: {
    id: string;
    name: string;
    hasAvatar?: boolean;
    avatarUpdatedAt?: number | null;
  } | null | undefined;
  size?: "default" | "sm" | "lg";
  className?: string;
  /** Overridden where a surface needs a different tint -- the sidebar plate, say. */
  fallbackClassName?: string;
}) {
  const showImage = Boolean(user?.hasAvatar || user?.avatarUpdatedAt);

  return (
    <Avatar size={size} className={cn("shrink-0", className)}>
      {showImage && user && (
        <AvatarImage
          src={avatarUrl(user.id, user.avatarUpdatedAt)}
          alt=""
          // The name is already beside every one of these, so announcing it
          // again from the picture would have a screen reader say it twice.
          crossOrigin="use-credentials"
        />
      )}
      <AvatarFallback
        className={cn("bg-primary/10 font-semibold text-primary", fallbackClassName)}
      >
        {user ? initials(user.name) : "?"}
      </AvatarFallback>
    </Avatar>
  );
}
