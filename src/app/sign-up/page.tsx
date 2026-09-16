import type { Metadata } from "next";
import { Suspense } from "react";
import { SignUpForm } from "@/components/auth/sign-up-form";

export const metadata: Metadata = { title: "Create Account" };

export default function SignUpPage() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <h1 className="font-display text-3xl font-bold text-white">Create Your Account</h1>
      <p className="mt-2 text-sm text-muted">Book faster and manage your rentals in one place.</p>
      <div className="mt-8">
        <Suspense fallback={null}>
          <SignUpForm />
        </Suspense>
      </div>
    </div>
  );
}
