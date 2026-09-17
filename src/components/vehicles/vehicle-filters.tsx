"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VEHICLE_CATEGORY_LABELS } from "@/lib/constants";

const CATEGORIES = ["ALL", "SEDAN", "SUV", "LUXURY", "ECONOMY", "TRUCK"];
const SORTS = [
  { value: "recommended", label: "Recommended" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "newest", label: "Newest" },
];

export function VehicleFilters({ makes }: { makes: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const update = useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  const content = (
    <div className="flex flex-col gap-5">
      <div>
        <Label htmlFor="f-pickup-date">Pickup Date</Label>
        <input
          id="f-pickup-date"
          type="date"
          defaultValue={searchParams.get("pickupDate") ?? ""}
          onChange={(e) => update({ pickupDate: e.target.value })}
          className="mt-1.5 flex h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
        />
      </div>
      <div>
        <Label htmlFor="f-return-date">Return Date</Label>
        <input
          id="f-return-date"
          type="date"
          defaultValue={searchParams.get("returnDate") ?? ""}
          onChange={(e) => update({ returnDate: e.target.value })}
          className="mt-1.5 flex h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
        />
      </div>

      <div>
        <Label>Vehicle Type</Label>
        <Select value={searchParams.get("category") ?? "ALL"} onValueChange={(v) => update({ category: v })}>
          <SelectTrigger className="mt-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {VEHICLE_CATEGORY_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Make</Label>
        <Select value={searchParams.get("make") ?? "ANY"} onValueChange={(v) => update({ make: v === "ANY" ? undefined : v })}>
          <SelectTrigger className="mt-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ANY">Any Make</SelectItem>
            {makes.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Transmission</Label>
        <Select
          value={searchParams.get("transmission") ?? "ANY"}
          onValueChange={(v) => update({ transmission: v === "ANY" ? undefined : v })}
        >
          <SelectTrigger className="mt-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ANY">Any</SelectItem>
            <SelectItem value="AUTOMATIC">Automatic</SelectItem>
            <SelectItem value="MANUAL">Manual</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Minimum Seats</Label>
        <Select value={searchParams.get("seats") ?? "ANY"} onValueChange={(v) => update({ seats: v === "ANY" ? undefined : v })}>
          <SelectTrigger className="mt-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ANY">Any</SelectItem>
            {[2, 4, 5, 6, 7].map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s}+
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Daily Price Range ($)</Label>
        <div className="mt-1.5 flex items-center gap-2">
          <Input
            type="number"
            min={0}
              placeholder="Min"
              aria-label="Minimum daily price in dollars"
            defaultValue={searchParams.get("priceMin") ?? ""}
            onChange={(e) => update({ priceMin: e.target.value || undefined })}
          />
          <span className="text-muted">–</span>
          <Input
            type="number"
            min={0}
              placeholder="Max"
              aria-label="Maximum daily price in dollars"
            defaultValue={searchParams.get("priceMax") ?? ""}
            onChange={(e) => update({ priceMax: e.target.value || undefined })}
          />
        </div>
      </div>

      <Button variant="ghost" onClick={() => router.push(pathname)} className="justify-start px-0">
        <X className="h-4 w-4" /> Clear all filters
      </Button>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-72 shrink-0 rounded-xl border border-white/10 bg-card p-6 lg:block">
        <h2 className="font-display text-lg font-semibold text-white">Filters</h2>
        <div className="mt-5">{content}</div>
      </aside>

      {/* Mobile filter trigger */}
      <div className="mb-4 flex items-center justify-between lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="outline">
              <Filter className="h-4 w-4" /> Filters
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="overflow-y-auto">
            <SheetTitle>Filters</SheetTitle>
            <div className="mt-5">{content}</div>
          </SheetContent>
        </Sheet>

        <Select
          value={searchParams.get("sort") ?? "recommended"}
          onValueChange={(v) => update({ sort: v })}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

export function SortSelect() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <Select
      value={searchParams.get("sort") ?? "recommended"}
      onValueChange={(v) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("sort", v);
        router.push(`${pathname}?${params.toString()}`);
      }}
    >
      <SelectTrigger className="w-52">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SORTS.map((s) => (
          <SelectItem key={s.value} value={s.value}>
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
