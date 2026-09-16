import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = { title: "Sign In" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <h1 className="font-display text-3xl font-bold text-white">Sign In</h1>
      <p className="mt-2 text-sm text-muted">Access your reservations and account details.</p>
      <div className="mt-8">
        <SignInForm callbackUrl={callbackUrl} />
      </div>
    </div>
  );
}
