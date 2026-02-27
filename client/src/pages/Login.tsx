import { FormEvent, useMemo, useState } from "react";
import { useUser } from "@/hooks/use-user";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import logo from "@/assets/NUlogo-Dark.png";

function parseErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : "Unable to sign in.";
  const normalized = raw.replace(/^Error:\s*/, "");
  const jsonMatch = normalized.match(/\{.*\}$/);
  if (!jsonMatch) return normalized;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { message?: string };
    return parsed.message || normalized;
  } catch {
    return normalized;
  }
}

export default function Login() {
  const { user } = useUser();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const searchParams = new URLSearchParams(window.location.search);
  const oauthError = searchParams.get("error");
  const oauthErrorMessage = useMemo(() => {
    if (!oauthError) return null;
    if (oauthError === "oauth_not_configured") {
      return "SSO is not configured right now. Use username and password instead.";
    }
    return "Your account is not provisioned or is inactive.";
  }, [oauthError]);

  if (user) {
    window.location.href = "/dashboard";
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const normalizedUsername = username.trim();
      const normalizedPassword = password.trim();
      await apiRequest("POST", "/api/auth/login/password", {
        username: normalizedUsername,
        password: normalizedPassword,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      window.location.href = "/dashboard";
    } catch (error) {
      setErrorMessage(parseErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden">
      <div className="absolute inset-0 bg-grid-slate-100 [mask-image:linear-gradient(0deg,white,rgba(255,255,255,0.6))] dark:bg-grid-slate-700/25 dark:[mask-image:linear-gradient(0deg,rgba(255,255,255,0.1),rgba(255,255,255,0.5))]" />

      <div className="relative z-10 w-full max-w-md px-4">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="h-24 w-24 rounded-full bg-white shadow-xl p-4 flex items-center justify-center mb-6 ring-4 ring-primary/20">
            <img
              src={logo}
              alt="National University Logo"
              className="h-full w-full object-contain"
            />
          </div>
          <h1 className="text-3xl font-display font-bold text-foreground tracking-tight leading-tight">
            <span className="block">QMO-Manila</span>
            <span className="block">DataOps</span>
          </h1>
          <p className="text-muted-foreground mt-2 text-lg">
            National University Manila
          </p>
        </div>

        <Card className="border-border/50 shadow-2xl backdrop-blur-sm bg-card/95">
          <CardHeader>
            <CardTitle>Sign In</CardTitle>
            <CardDescription>
              Enter your username and password to access the dashboard
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {oauthErrorMessage ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {oauthErrorMessage}
              </div>
            ) : null}
            {errorMessage ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorMessage}
              </div>
            ) : null}

            <form className="space-y-3" onSubmit={handleSubmit}>
              <Input
                type="text"
                required
                placeholder="Username (email or prefix)"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
              <Input
                type="password"
                required
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <Button
                type="submit"
                className="w-full h-11 text-base font-semibold shadow-lg shadow-primary/20 hover:shadow-primary/40 transition-all"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" />
                    Signing in...
                  </>
                ) : (
                  "Sign In"
                )}
              </Button>
            </form>
          </CardContent>
          <CardFooter>
            <p className="text-xs text-muted-foreground">
              Access is limited to active users registered in Supabase.
            </p>
          </CardFooter>
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-8">
          (c) 2025 National University. All rights reserved. <br />
          Quality Management Office
        </p>
      </div>
    </div>
  );
}
