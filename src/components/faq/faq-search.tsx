"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";

interface FaqItem {
  id: string;
  question: string;
  answer: string;
}
interface FaqCategoryData {
  id: string;
  name: string;
  faqs: FaqItem[];
}

export function FaqSearch({ categories }: { categories: FaqCategoryData[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return categories;
    const q = query.toLowerCase();
    return categories
      .map((cat) => ({
        ...cat,
        faqs: cat.faqs.filter((f) => f.question.toLowerCase().includes(q) || f.answer.toLowerCase().includes(q)),
      }))
      .filter((cat) => cat.faqs.length > 0);
  }, [categories, query]);

  return (
    <div>
      <div className="relative mx-auto max-w-xl">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search frequently asked questions…"
          className="pl-10"
        />
      </div>

      <div className="mx-auto mt-10 max-w-3xl space-y-10">
        {filtered.map((cat) => (
          <div key={cat.id}>
            <h2 className="font-display text-xl font-semibold text-gold-bright">{cat.name}</h2>
            <Accordion type="single" collapsible className="mt-2">
              {cat.faqs.map((f) => (
                <AccordionItem key={f.id} value={f.id}>
                  <AccordionTrigger>{f.question}</AccordionTrigger>
                  <AccordionContent>{f.answer}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        ))}
        {filtered.length === 0 && <p className="text-center text-muted">No results found for &quot;{query}&quot;.</p>}
      </div>
    </div>
  );
}
