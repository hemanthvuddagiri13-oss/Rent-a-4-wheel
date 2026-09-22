"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Passwordless sign-in: enter an email, receive a 6-digit code, enter the
 * code. If no account exists for that email, one is created automatically
 * once the code is verified (see src/auth.ts) — there is no separate
 * "create account" form or password to set.
 */
export function EmailCodeForm({ callbackUrl, onSuccess }: { callbackUrl?: string; onSuccess?: () => void }) {
  const router = useRouter();
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Something went wrong.");
        return;
      }
      setStage("code");
      setInfo(
        data.devCode
          ? `Development mode — email isn't configured. Your code is: ${data.devCode}`
          : "We sent a 6-digit code to your email."
      );
      setCooldown(60);
      const timer = setInterval(() => {
        setCooldown((c) => {
          if (c <= 1) {
            clearInterval(timer);
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    } catch {
      setError("We could not confirm the code request. Check your email before requesting another code.");
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await signIn("email-code", { email, code, redirect: false });
      if (res?.error) { setError("Invalid or expired code. Please try again."); return; }
      if (onSuccess) { onSuccess(); return; }
      router.push(callbackUrl || "/account"); router.refresh();
    } catch { setError("Sign-in could not be confirmed. Please try again or request a new code."); }
    finally { setLoading(false); }
  }

  if (stage === "email") {
    return (
      <form onSubmit={requestCode} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5"
          />
        </div>
        {error && <p role="alert" className="text-sm text-negative">{error}</p>}
        <Button type="submit" className="w-full" size="lg" disabled={loading || !email}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />} Continue with Email
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted">
          <ShieldCheck className="h-4 w-4 text-gold" /> No password needed — we&apos;ll email you a one-time code.
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={verifyCode} className="space-y-4">
      <p className="text-sm text-muted">
        Enter the code sent to <span className="text-white">{email}</span>.
      </p>
      <div>
        <Label htmlFor="code">6-digit code</Label>
        <Input
          id="code"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className="mt-1.5 tracking-[0.5em] text-center text-lg"
        />
      </div>
      {info && <p data-sensitive role="status" className="text-sm text-muted">{info}</p>}
      {error && <p role="alert" className="text-sm text-negative">{error}</p>}
      <Button type="submit" className="w-full" size="lg" disabled={loading || code.length !== 6}>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />} Verify &amp; Continue
      </Button>
      <button
        type="button"
        onClick={() => requestCode()}
        disabled={cooldown > 0 || loading}
        className="min-h-11 w-full text-center text-sm text-gold hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
      >
        {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
      </button>
      <button
        type="button"
        onClick={() => {
          setStage("email");
          setCode("");
          setError(null);
        }}
        className="min-h-11 w-full text-center text-sm text-muted hover:underline"
      >
        Use a different email
      </button>
    </form>
  );
}
