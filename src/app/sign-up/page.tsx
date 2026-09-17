import { redirect } from "next/navigation";

// Sign-up and sign-in are the same passwordless email-code flow — an
// account is created automatically on first verified sign-in, so there is
// no separate registration form.
export default function SignUpPage() {
  redirect("/sign-in");
}
