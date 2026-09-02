import { LogOut, ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { BrandBackdrop } from "@/components/BrandBackdrop";
import { useAuth } from "@/context/AuthContext";
import { clearOfflineCaches } from "@/lib/pwa";

/**
 * The wall somebody meets when their password has reached the end of its month.
 *
 * Stands in front of every route rather than appearing as a banner on one,
 * because the server is already refusing every other endpoint
 * (middleware/auth.js) -- a dashboard rendered behind a dismissible notice
 * would be a screen full of failed requests and error states, which reads as a
 * broken app rather than a policy.
 *
 * Two ways out and no third: set a new password, or sign out. Deliberately not
 * a dead end -- an account that cannot remember its current password can sign
 * out and use the forgotten-password link on the sign-in page.
 */
export function PasswordResetRequired() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-background p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-secondary/40 via-background to-background"
      />
      <BrandBackdrop />

      <Card className="relative z-10 w-full max-w-md border-destructive/30 shadow-2xl">
        <CardHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/10 text-destructive">
            <ShieldAlert className="size-5" />
          </div>
          <CardTitle className="text-lg">Time for a new password</CardTitle>
          <CardDescription>
            {user?.name ? `${user.name}, your` : "Your"} password has reached the end of its month.
            Set a new one and you will be straight back where you were.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <ChangePasswordForm submitLabel="Set new password and continue" />

          <div className="border-t border-border/60 pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => {
                clearOfflineCaches();
                logout();
                navigate("/login");
              }}
            >
              <LogOut className="size-3.5" />
              Sign out instead
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">
              Cannot remember the current one? Sign out and use “Forgot password” on the sign-in page.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
