"use client";

import { useId, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VEHICLE_CATEGORY_LABELS } from "@/lib/constants";

const sorts = [["recommended", "Recommended"], ["price_asc", "Price: low to high"], ["price_desc", "Price: high to low"], ["newest", "Newest"]];
const filterLabels: Record<string, string> = { category: "Type", make: "Make", transmission: "Transmission", seats: "Minimum seats", priceMin: "Minimum daily price", priceMax: "Maximum daily price" };

function FilterForm({ makes }: { makes: string[] }) {
  const params = useSearchParams(), pathname = usePathname(), id = useId();
  const choices = [
    { name: "category", options: Object.entries(VEHICLE_CATEGORY_LABELS).filter(([key]) => key !== "ALL") },
    { name: "make", options: makes.map(make => [make, make]) },
    { name: "transmission", options: [["AUTOMATIC", "Automatic"], ["MANUAL", "Manual"]] },
    { name: "seats", options: [2, 4, 5, 6, 7].map(seats => [String(seats), `${seats}+`]) },
  ];
  return <form action={pathname} method="get" className="space-y-5" key={params.toString()}>
    {["location", "pickupDate", "pickupTime", "returnDate", "returnTime", "sort"].map(name => params.has(name) && <input type="hidden" name={name} value={params.get(name)!} key={name} />)}
    {choices.map(({ name, options }) => <div key={name}>
      <label htmlFor={id + name} className="mb-2 block text-sm font-medium text-silver">{filterLabels[name]}</label>
      <select id={id + name} name={name} defaultValue={params.get(name) ?? ""} className="workspace-input text-base"><option value="">Any</option>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    </div>)}
    <fieldset><legend className="mb-2 text-sm font-medium text-silver">Daily rental price (USD)</legend><p className="mb-3 text-sm text-muted">Before fees, taxes, extras and any deposit.</p><div className="grid grid-cols-2 gap-3">{["priceMin", "priceMax"].map(name => <div key={name}><label htmlFor={id + name} className="mb-2 block text-sm text-silver">{name === "priceMin" ? "Minimum" : "Maximum"}</label><Input id={id + name} name={name} type="number" min={0} defaultValue={params.get(name) ?? ""} /></div>)}</div></fieldset>
    <Button type="submit" className="w-full">Apply filters</Button>
    <Button asChild variant="ghost" className="w-full"><Link href={pathname}>Clear dates and filters</Link></Button>
  </form>;
}
export function VehicleFilters({ makes }: { makes: string[] }) {
  const [open, setOpen] = useState(false);
  return <>
    <aside aria-label="Vehicle filters" className="hidden w-64 shrink-0 self-start rounded-xl border border-white/10 bg-card p-5 lg:block"><h2 className="mb-5 text-lg font-semibold">Filters</h2><FilterForm makes={makes} /></aside>
    <div className="flex flex-wrap items-center justify-between gap-3 lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}><SheetTrigger asChild><Button variant="outline"><Filter aria-hidden="true" className="h-4 w-4" />Filters</Button></SheetTrigger><SheetContent side="left" className="w-[min(90vw,24rem)]"><SheetTitle>Filter vehicles</SheetTitle><div className="mt-6"><FilterForm makes={makes} /></div></SheetContent></Sheet>
      <SortSelect />
    </div>
  </>;
}
export function ActiveFilterChips() {
  const params = useSearchParams(), pathname = usePathname();
  const active = Object.entries(filterLabels).filter(([key]) => params.get(key) && params.get(key) !== "ALL" && params.get(key) !== "ANY");
  if (!active.length) return null;
  return <nav aria-label="Active filters" className="mb-5 flex flex-wrap gap-2">{active.map(([key, label]) => {
    const next = new URLSearchParams(params.toString()); next.delete(key);
    return <Link key={key} href={`${pathname}?${next}`} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm text-silver"><span className="break-words">{label}: {params.get(key)?.replaceAll("_", " ")}</span><X aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="sr-only">Remove filter</span></Link>;
  })}</nav>;
}
export function SortSelect() {
  const router = useRouter(), pathname = usePathname(), params = useSearchParams(), id = useId();
  return <div className="min-w-0 max-w-full"><label htmlFor={id} className="sr-only">Sort vehicles</label><select id={id} value={params.get("sort") ?? "recommended"} className="workspace-input max-w-52 text-base" onChange={event => { const next = new URLSearchParams(params.toString()); next.set("sort", event.target.value); router.push(`${pathname}?${next}`); }}>{sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>;
}
