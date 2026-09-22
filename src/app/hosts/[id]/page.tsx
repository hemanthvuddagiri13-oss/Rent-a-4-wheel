import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { visibleJurisdictions } from "@/lib/jurisdiction";
import { publicTripReviews } from "@/lib/trip-reviews";
import { VehicleCard } from "@/components/vehicles/vehicle-card";
import { toVehicleCardData } from "@/lib/data/vehicles";

export const dynamic = "force-dynamic";
export default async function PublicHostPage({params}:{params:Promise<{id:string}>}) {
  const {id}=await params;
  const host=await prisma.hostProfile.findFirst({where:{id,onboardingStatus:"APPROVED"},select:{businessName:true}});
  const vehicles=await prisma.vehicle.findMany({where:{hostId:id,status:"ACTIVE",isDemo:false,listingApproval:"APPROVED",jurisdictionCode:{in:await visibleJurisdictions()}},include:{images:{orderBy:{position:"asc"}}},orderBy:{createdAt:"desc"}});
  if(!host||!vehicles.length)notFound();
  const reviews=await publicTripReviews("HOST",id);
  return <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6"><Link className="inline-flex min-h-11 items-center underline" href="/vehicles">Find a car</Link><header><p className="text-sm text-muted">Independent vehicle provider</p><h1 className="mt-2 break-words text-3xl font-semibold">{host.businessName||"Your vehicle host"}</h1><p className="mt-3 max-w-2xl text-silver">This host stores, maintains and coordinates handoffs for their vehicles. Ask questions through the listing before booking.</p></header><section><h2 className="mb-4 text-2xl">Available vehicles</h2><div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">{vehicles.map(vehicle=><VehicleCard key={vehicle.id} vehicle={toVehicleCardData(vehicle)} />)}</div></section><section><h2 className="mb-4 text-2xl">Published trip reviews</h2><p className="text-silver">{reviews.count?`${reviews.average?.toFixed(1)} / 5 from ${reviews.count} reviews`:"No published reviews yet."}</p>{reviews.reviews.map(review=><blockquote key={review.id} className="my-4 rounded-xl border border-white/15 p-5"><p>{review.rating} / 5</p><p className="mt-2 whitespace-pre-wrap break-words">{review.body}</p></blockquote>)}</section></div>;
}
