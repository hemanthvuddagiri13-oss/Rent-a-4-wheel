import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { DeleteFaqButton } from "@/components/admin/delete-faq-button";
import { createFaq } from "@/app/admin/faq/actions";

export const metadata: Metadata = { title: "FAQ", robots: { index: false } };
export const revalidate = 0;

export default async function AdminFaqPage() {
  const categories = await prisma.faqCategory.findMany({
    include: { faqs: { orderBy: { position: "asc" } } },
    orderBy: { position: "asc" },
  });

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-3xl font-bold text-white">FAQ</h1>

      <form action={createFaq} className="mt-6 space-y-3 rounded-xl border border-white/10 bg-card p-5">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Add Question</h2>
        <div>
          <Label htmlFor="category">Category</Label>
          <Input id="category" name="category" required list="faq-categories" className="mt-1.5" />
          <datalist id="faq-categories">
            {categories.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </div>
        <div>
          <Label htmlFor="question">Question</Label>
          <Input id="question" name="question" required className="mt-1.5" />
        </div>
        <div>
          <Label htmlFor="answer">Answer</Label>
          <Textarea id="answer" name="answer" required className="mt-1.5" rows={3} />
        </div>
        <Button type="submit">Add</Button>
      </form>

      <div className="mt-8 space-y-6">
        {categories.map((c) => (
          <div key={c.id}>
            <h2 className="font-display text-lg font-semibold text-gold-bright">{c.name}</h2>
            <div className="mt-3 space-y-2">
              {c.faqs.map((f) => (
                <div key={f.id} className="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-card p-3">
                  <div>
                    <p className="text-sm font-medium text-white">{f.question}</p>
                    <p className="mt-1 text-sm text-muted">{f.answer}</p>
                  </div>
                  <DeleteFaqButton faqId={f.id} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
