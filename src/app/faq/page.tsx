import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { FaqSearch } from "@/components/faq/faq-search";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Answers to frequently asked questions about renting with Rent A 4Wheel in Dallas, TX.",
  alternates: { canonical: "/faq" },
};

export const revalidate = 300;

export default async function FaqPage() {
  const categories = await prisma.faqCategory.findMany({
    where: { faqs: { some: { isPublished: true } } },
    include: { faqs: { where: { isPublished: true }, orderBy: { position: "asc" } } },
    orderBy: { position: "asc" },
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="text-center">
        <h1 className="font-display text-4xl font-bold uppercase tracking-tight text-white">
          Frequently Asked Questions
        </h1>
        <p className="mt-3 text-muted">Everything you need to know before you book.</p>
      </div>

      <div className="mt-10">
        <FaqSearch categories={categories} />
      </div>
    </div>
  );
}
