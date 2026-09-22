"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

function defaultDate(daysFromNow: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return format(d, "yyyy-MM-dd");
}

export function SearchWidget({ locations = [], initial = {} }: { locations?: string[]; initial?: Record<string, string | undefined> }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [location, setLocation] = useState(initial.location ?? "");
  const [pickupDate, setPickupDate] = useState(initial.pickupDate ?? defaultDate(1));
  const [pickupTime, setPickupTime] = useState(initial.pickupTime ?? "10:00");
  const [returnDate, setReturnDate] = useState(initial.returnDate ?? defaultDate(4));
  const [returnTime, setReturnTime] = useState(initial.returnTime ?? "10:00");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (`${returnDate}T${returnTime}` <= `${pickupDate}T${pickupTime}`) {
      setError("Choose a return date and time after pickup.");
      return;
    }
    setError("");
    const params = new URLSearchParams({
      location,
      pickupDate,
      pickupTime,
      returnDate,
      returnTime,
    });
    for (const name of ["category", "make", "transmission", "seats", "priceMin", "priceMax", "sort"]) {
      if (initial[name]) params.set(name, initial[name]!);
    }
    router.push(`/vehicles?${params.toString()}`);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="glass w-full max-w-4xl rounded-2xl border border-white/10 p-4 shadow-2xl sm:p-6"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-1">
          <Label htmlFor="pickup-location">Pickup Location</Label>
          <input id="pickup-location" list="pickup-locations" value={location} onChange={e => setLocation(e.target.value)} maxLength={200} placeholder="City or area" className="workspace-input mt-1.5" />
          <datalist id="pickup-locations">{locations.map(loc => <option key={loc} value={loc} />)}</datalist>
        </div>

        <div>
          <Label htmlFor="pickup-date">Pickup Date</Label>
          <input
            id="pickup-date"
            type="date"
            required
            value={pickupDate}
            min={defaultDate(0)}
            onChange={(e) => setPickupDate(e.target.value)}
            className="mt-1.5 flex h-11 min-w-0 w-full rounded-md border border-white/15 bg-card px-3 text-base text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>

        <div>
          <Label htmlFor="pickup-time">Pickup Time</Label>
          <input
            id="pickup-time"
            type="time"
            required
            value={pickupTime}
            onChange={(e) => setPickupTime(e.target.value)}
            className="mt-1.5 flex h-11 min-w-0 w-full rounded-md border border-white/15 bg-card px-3 text-base text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>

        <div>
          <Label htmlFor="return-date">Return Date</Label>
          <input
            id="return-date"
            type="date"
            required
            value={returnDate}
            min={pickupDate}
            onChange={(e) => setReturnDate(e.target.value)}
            className="mt-1.5 flex h-11 min-w-0 w-full rounded-md border border-white/15 bg-card px-3 text-base text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>

        <div>
          <Label htmlFor="return-time">Return Time</Label>
          <input
            id="return-time"
            type="time"
            required
            value={returnTime}
            onChange={(e) => setReturnTime(e.target.value)}
            className="mt-1.5 flex h-11 min-w-0 w-full rounded-md border border-white/15 bg-card px-3 text-base text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>
      </div>

      {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
      <Button type="submit" size="lg" className="mt-5 w-full text-base">
        <Search className="h-5 w-5" />
        SEARCH VEHICLES
      </Button>
    </form>
  );
}
