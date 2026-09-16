import { Hero } from "@/components/home/hero";
import { TrustBar } from "@/components/home/trust-bar";
import { VehicleShowcase } from "@/components/home/vehicle-showcase";
import { WhyUs } from "@/components/home/why-us";
import { HowItWorks } from "@/components/home/how-it-works";
import { LongTermCta } from "@/components/home/long-term-cta";
import { ReviewsCarousel } from "@/components/home/reviews-carousel";
import { FinalCta } from "@/components/home/final-cta";
import { getFeaturedVehicles } from "@/lib/data/vehicles";
import { getPublishedReviews } from "@/lib/data/reviews";

export const revalidate = 300;

export default async function HomePage() {
  const [vehicles, reviews] = await Promise.all([getFeaturedVehicles(9), getPublishedReviews(10)]);

  return (
    <>
      <Hero />
      <TrustBar />
      <VehicleShowcase vehicles={vehicles} />
      <WhyUs />
      <HowItWorks />
      <LongTermCta />
      {reviews.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <h2 className="mb-12 text-center font-display text-3xl font-bold uppercase tracking-tight text-white sm:text-4xl">
            What Our Customers Say
          </h2>
          <ReviewsCarousel reviews={reviews} />
        </section>
      )}
      <FinalCta />
    </>
  );
}
