import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/marketplace/action-form";
import { Workspace, Panel, HostNav } from "@/components/marketplace/workspace";
export default async function ProfilePage() {
  const session = await auth();
  const profile = session?.user ? await prisma.hostProfile.findUnique({ where: { userId: session.user.id } }) : null;
  return <Workspace eyebrow="Host onboarding" title="Your business profile" description="Your legal and contact details are reviewed before your listings can accept bookings."><HostNav /><Panel title="Business details"><ActionForm action="profile" label="Submit for review" redirectTo="/host" fields={[
    { name: "legalName", label: "Legal name", value: profile?.legalName ?? "" },
    { name: "businessName", label: "Business name", value: profile?.businessName ?? "" },
    { name: "phone", label: "Business phone", type: "tel", value: profile?.phone ?? "" },
    { name: "addressLine1", label: "Business address", value: profile?.addressLine1 ?? "" },
    { name: "city", label: "City", value: profile?.city ?? "" },
    { name: "state", label: "State", value: profile?.state ?? "" },
    { name: "zip", label: "ZIP code", value: profile?.zip ?? "" },
  ]} /></Panel></Workspace>;
}
