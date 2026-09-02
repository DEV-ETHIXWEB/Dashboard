import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUpload } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { prepareAvatar } from "@/lib/avatar";
import type { CredentialDelivery, PasswordStatus, User } from "@/lib/types";

/** One entry in the person's own activity list. Never names a colleague. */
export interface ProfileActivity {
  id: string;
  action: string;
  createdAt: string;
  bySelf: boolean;
  actor: string;
}

export interface ProfileSession {
  id: string;
  createdAt: number;
  expiresAt: number;
  current: boolean;
  /** "Chrome on Windows", or "Unknown device" when the browser said nothing. */
  device: string;
  deviceKind: "phone" | "tablet" | "desktop" | "unknown";
  /** Only ever shown to the account that owns the session. */
  ipAddress: string | null;
}

export interface AvatarMeta {
  userId: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  updatedAt: string | null;
}

export interface ProfileBundle {
  user: User;
  passwordStatus: PasswordStatus;
  avatar: AvatarMeta | null;
  lastLoginAt: string | null;
  activity: ProfileActivity[];
  sessions: ProfileSession[];
  pendingDelivery: CredentialDelivery | null;
}

/**
 * Everything the profile page shows, in one read.
 *
 * Your own account only -- there is no id form of this on the server either.
 */
export function useProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => api<ProfileBundle>("GET", "/users/me/profile"),
    enabled: Boolean(user),
  });
}

/**
 * Change your own password.
 *
 * The current one is required by the server and asked for here, so a borrowed
 * session cannot lock the real owner out of their account.
 */
export function useChangePassword() {
  const qc = useQueryClient();
  const { refreshUser } = useAuth();
  return useMutation({
    mutationFn: (body: { currentPassword: string; password: string }) =>
      api<{ user: User }>("PUT", "/users/me", body),
    onSuccess: async () => {
      // The password status on the session is now stale, and so is the block
      // that may have been standing in front of the rest of the app.
      await refreshUser();
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

/** Update the name or email on your own account. */
export function useUpdateOwnDetails() {
  const qc = useQueryClient();
  const { refreshUser } = useAuth();
  return useMutation({
    mutationFn: (body: { name?: string; email?: string }) =>
      api<{ user: User }>("PUT", "/users/me", body),
    onSuccess: async () => {
      await refreshUser();
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

/**
 * Upload a picture.
 *
 * The file is cropped and scaled in the browser first (see lib/avatar.ts), so
 * what crosses the wire is an avatar rather than whatever came off the camera.
 * The server validates it again regardless.
 */
export function useUploadAvatar() {
  const qc = useQueryClient();
  const { refreshUser } = useAuth();
  return useMutation({
    mutationFn: async ({ userId, file }: { userId: string; file: File }) => {
      const blob = await prepareAvatar(file);
      const form = new FormData();
      // The filename is not trusted by the server -- it reads the bytes -- but
      // multipart wants one, and a stable name keeps the request tidy.
      form.set("avatar", blob, "avatar");
      return apiUpload<{ avatar: AvatarMeta; avatarUpdatedAt: number }>(
        `/users/${encodeURIComponent(userId)}/avatar`,
        form,
      );
    },
    onSuccess: async () => {
      await refreshUser();
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useRemoveAvatar() {
  const qc = useQueryClient();
  const { refreshUser } = useAuth();
  return useMutation({
    mutationFn: (userId: string) =>
      api<{ ok: boolean; removed: boolean }>("DELETE", `/users/${encodeURIComponent(userId)}/avatar`),
    onSuccess: async () => {
      await refreshUser();
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

/** Sign out every other browser. The one you are using survives. */
export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean; revoked: number }>("DELETE", "/users/me/sessions"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }),
  });
}
