"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { HardDrive } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const router = useRouter();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push("/");
      router.refresh();
    }
  }

  async function handleGoogleSignIn() {
    setGoogleLoading(true);
    setError("");

    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
      },
    });

    if (error) {
      setError(error.message);
      setGoogleLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-8">
        <div className="flex flex-col items-center gap-2">
          <HardDrive className="h-10 w-10 text-primary" />
          <h1 className="text-xl font-bold">NAS Monitor</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to your dashboard
          </p>
        </div>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={googleLoading || loading}
          className="flex w-full items-center justify-center gap-3 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted/40 disabled:opacity-50"
        >
          <GoogleMark />
          {googleLoading ? "Redirecting to Google..." : "Continue with Google"}
        </button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-muted-foreground mb-1.5"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              required
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-muted-foreground mb-1.5"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              required
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M21.805 12.041c0-.817-.067-1.412-.212-2.03H12.24v3.71h5.49c-.11.922-.712 2.31-2.05 3.242l-.018.124 2.996 2.274.208.02c1.905-1.719 2.999-4.248 2.999-7.34Z"
        fill="#4285F4"
      />
      <path
        d="M12.24 21.75c2.688 0 4.947-.865 6.596-2.37l-3.186-2.418c-.853.582-2 .99-3.41.99-2.633 0-4.869-1.718-5.666-4.094l-.12.01-3.115 2.361-.042.113c1.639 3.185 5.014 5.408 8.943 5.408Z"
        fill="#34A853"
      />
      <path
        d="M6.574 13.858a5.86 5.86 0 0 1-.333-1.898c0-.663.122-1.305.322-1.897l-.006-.127-3.155-2.399-.103.048A9.705 9.705 0 0 0 2.25 11.96c0 1.54.378 2.997 1.05 4.375l3.274-2.477Z"
        fill="#FBBC05"
      />
      <path
        d="M12.24 5.968c1.778 0 2.977.75 3.663 1.377l2.677-2.563C17.176 3.486 14.928 2.25 12.24 2.25c-3.93 0-7.304 2.223-8.943 5.408l3.264 2.478c.809-2.376 3.043-4.168 5.678-4.168Z"
        fill="#EB4335"
      />
    </svg>
  );
}
