import { prisma } from "@/lib/prisma";
import type { ReviewData } from "@/components/home/reviews-carousel";
export async function getPublishedReviews(limit = 10): Promise<ReviewData[]> {
 const eligible=await prisma.reservation.findMany({where:{status:"COMPLETED",trip:{startedAt:{not:null},endedAt:{not:null}},vehicle:{isDemo:false}},select:{id:true}});
 const reviews=await prisma.tripReview.findMany({where:{subject:"VEHICLE",hidden:false,publishAfter:{lte:new Date()},reservationId:{in:eligible.map(r=>r.id)}},select:{id:true,rating:true,body:true},orderBy:{createdAt:"desc"},take:limit});
 return reviews.map(r=>({id:r.id,rating:r.rating,comment:r.body,authorName:"Verified trip customer"}));
}
