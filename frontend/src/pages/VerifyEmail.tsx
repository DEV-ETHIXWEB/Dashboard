import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { LoginResponse } from "@/lib/types";
import * as fb2fa from "@/lib/firebase2fa";

export default function VerifyEmail() {
  const { config, setSession } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"working" | "error">("working");
  const [message, setMessage] = useState("Verifying your sign-in link…");

  useEffect(() => {
    (async () => {
      if (!config?.firebaseConfig) return;
      try {
        await fb2fa.loadFirebase(config.firebaseConfig);
        const firebaseIdToken = await fb2fa.completeEmailSignIn();
        const d = await api<LoginResponse>("POST", "/auth/verify-2fa", { firebaseIdToken });
        if (d.user) setSession(d.user, d.csrfToken);
        setTimeout(() => navigate("/portal"), 800);
      } catch (err) {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Verification failed");
      }
    })();
  }, [config?.firebaseConfig]);

  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          {status === "working" ? (
            <Loader2 className="size-8 animate-spin text-primary" />
          ) : (
            <XCircle className="size-8 text-destructive" />
          )}
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    </div>
  );
}
