"use client";

import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function RevenueChart({
  revenue,
  bookings,
}: {
  revenue: { month: string; revenue: number }[];
  bookings: { status: string; count: number }[];
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="rounded-xl border border-white/10 bg-card p-5">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Revenue (last 6 months)</h2>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={revenue}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="month" stroke="#8A8A8A" fontSize={12} />
              <YAxis stroke="#8A8A8A" fontSize={12} />
              <Tooltip
                contentStyle={{ background: "#111", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                formatter={(value) => [`$${Number(value).toFixed(2)}`, "Revenue"]}
              />
              <Line type="monotone" dataKey="revenue" stroke="#D4AF37" strokeWidth={2} dot={{ fill: "#F5C542" }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-card p-5">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Bookings by Status</h2>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bookings}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="status" stroke="#8A8A8A" fontSize={11} />
              <YAxis stroke="#8A8A8A" fontSize={12} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "#111", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
              <Bar dataKey="count" fill="#D4AF37" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
