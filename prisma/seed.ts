/**
 * Seed script — populates development database with sample/demo data.
 *
 * IMPORTANT: All vehicles, reviews, and customers created here are marked
 * `isDemo: true` where the schema supports it and use generic placeholder
 * information. This is NOT real company inventory. Replace via the admin
 * dashboard before going to production.
 */
import { PrismaClient, VehicleCategory, Transmission, FuelType, ExtraChargeType, LegalDocumentType, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { slugify } from "../src/lib/utils";

const prisma = new PrismaClient();

const PLACEHOLDER: Record<VehicleCategory, string> = {
  ECONOMY: "/images/vehicles/economy.svg",
  SEDAN: "/images/vehicles/sedan.svg",
  SUV: "/images/vehicles/suv.svg",
  LUXURY: "/images/vehicles/luxury.svg",
  TRUCK: "/images/vehicles/truck.svg",
};

const demoVehicles = [
  {
    year: 2023, make: "Nissan", model: "Versa", trim: "S", color: "White",
    category: VehicleCategory.ECONOMY, seats: 5, doors: 4, mpg: 35,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 3900, weeklyRateCents: 22900, monthlyRateCents: 74900,
    securityDepositCents: 30000, mileage: 18500,
    description: "A dependable, fuel-efficient economy car — perfect for everyday errands and budget-friendly city driving in Dallas.",
    vin: "1N4AL3AP0DC000001", plate: "RA4-1001",
  },
  {
    year: 2022, make: "Hyundai", model: "Accent", trim: "SE", color: "Silver",
    category: VehicleCategory.ECONOMY, seats: 5, doors: 4, mpg: 33,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 3700, weeklyRateCents: 21900, monthlyRateCents: 71900,
    securityDepositCents: 30000, mileage: 27300,
    description: "Compact and easy to park, the Accent is an economical choice for solo travelers or small families.",
    vin: "3KPC24A60NE000002", plate: "RA4-1002",
  },
  {
    year: 2024, make: "Toyota", model: "Camry", trim: "SE", color: "Charcoal",
    category: VehicleCategory.SEDAN, seats: 5, doors: 4, mpg: 32,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 4900, weeklyRateCents: 29900, monthlyRateCents: 89900,
    securityDepositCents: 35000, mileage: 9800,
    description: "The ever-popular Camry blends comfort, reliability, and a smooth ride for daily driving or road trips.",
    vin: "4T1G11AK0RU000003", plate: "RA4-1003",
  },
  {
    year: 2023, make: "Honda", model: "Accord", trim: "Sport", color: "Blue",
    category: VehicleCategory.SEDAN, seats: 5, doors: 4, mpg: 30,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 5200, weeklyRateCents: 31900, monthlyRateCents: 94900,
    securityDepositCents: 35000, mileage: 15200,
    description: "Spacious and refined, the Accord Sport offers a confident ride with modern tech and generous legroom.",
    vin: "1HGCV1F30PA000004", plate: "RA4-1004",
  },
  {
    year: 2023, make: "Toyota", model: "RAV4", trim: "LE", color: "Black",
    category: VehicleCategory.SUV, seats: 5, doors: 4, mpg: 28,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 6400, weeklyRateCents: 38900, monthlyRateCents: 119900,
    securityDepositCents: 40000, mileage: 21400,
    description: "A versatile compact SUV with plenty of cargo space — ideal for families and weekend getaways.",
    vin: "2T3F1RFV0PW000005", plate: "RA4-1005",
  },
  {
    year: 2024, make: "Chevrolet", model: "Traverse", trim: "LT", color: "White",
    category: VehicleCategory.SUV, seats: 7, doors: 4, mpg: 24,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 7900, weeklyRateCents: 47900, monthlyRateCents: 149900,
    securityDepositCents: 45000, mileage: 6200,
    description: "Three-row seating and a smooth highway ride make the Traverse a great pick for larger groups.",
    vin: "1GNERGKW0RJ000006", plate: "RA4-1006",
  },
  {
    year: 2023, make: "BMW", model: "5 Series", trim: "530i", color: "Black",
    category: VehicleCategory.LUXURY, seats: 5, doors: 4, mpg: 27,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 14900, weeklyRateCents: 89900, monthlyRateCents: 269900,
    securityDepositCents: 75000, mileage: 11300,
    description: "Executive comfort meets driving performance — leather appointments, premium sound, and a refined cabin.",
    vin: "WBA53AJ00PC000007", plate: "RA4-1007",
  },
  {
    year: 2024, make: "Mercedes-Benz", model: "C-Class", trim: "C300", color: "Silver",
    category: VehicleCategory.LUXURY, seats: 5, doors: 4, mpg: 29,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 15900, weeklyRateCents: 94900, monthlyRateCents: 279900,
    securityDepositCents: 80000, mileage: 4100,
    description: "A modern luxury sedan with cutting-edge tech and a whisper-quiet ride — arrive in style.",
    vin: "55SWF8DB0RU000008", plate: "RA4-1008",
  },
  {
    year: 2023, make: "Ford", model: "F-150", trim: "XLT", color: "Gray",
    category: VehicleCategory.TRUCK, seats: 5, doors: 4, mpg: 22,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 8900, weeklyRateCents: 53900, monthlyRateCents: 169900,
    securityDepositCents: 50000, mileage: 24800,
    description: "America's best-selling truck — plenty of towing capacity and bed space for work or play.",
    vin: "1FTFW1E50PF000009", plate: "RA4-1009",
  },
  {
    year: 2022, make: "Ram", model: "1500", trim: "Big Horn", color: "Blue",
    category: VehicleCategory.TRUCK, seats: 5, doors: 4, mpg: 21,
    transmission: Transmission.AUTOMATIC, fuelType: FuelType.GASOLINE,
    dailyRateCents: 8500, weeklyRateCents: 51900, monthlyRateCents: 159900,
    securityDepositCents: 50000, mileage: 31600,
    description: "A comfortable, capable full-size truck with a smooth ride and rugged towing capability.",
    vin: "1C6SRFFT0NN000010", plate: "RA4-1010",
  },
];

const featureNames = [
  "Apple CarPlay", "Android Auto", "Bluetooth", "Backup Camera",
  "Blind Spot Monitoring", "Leather Seats", "Navigation", "USB Charging",
  "Keyless Entry", "Sunroof", "Heated Seats", "Third-Row Seating",
];

async function main() {
  console.log("Seeding Rent A 4Wheel demo data...");

  // --- Users ---------------------------------------------------------------
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@renta4wheel.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
  const adminHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: "Rent A 4Wheel Admin",
      role: Role.ADMIN,
      passwordHash: adminHash,
      emailVerified: new Date(),
    },
  });

  const demoCustomerHash = await bcrypt.hash("Demo1234!", 12);
  const demoCustomerUser = await prisma.user.upsert({
    where: { email: "demo.customer@example.com" },
    update: {},
    create: {
      email: "demo.customer@example.com",
      name: "Jordan Sample",
      role: Role.CUSTOMER,
      phone: "214-555-0100",
      passwordHash: demoCustomerHash,
      emailVerified: new Date(),
      customer: {
        create: {
          addressLine1: "123 Sample St",
          city: "Dallas",
          state: "TX",
          zip: "75201",
          licenseNumber: "TX00000000",
          licenseState: "TX",
          licenseExpiration: new Date("2028-01-01"),
        },
      },
    },
  });

  // --- Features --------------------------------------------------------------
  const features = await Promise.all(
    featureNames.map((name) =>
      prisma.feature.upsert({ where: { name }, update: {}, create: { name } })
    )
  );
  const featureByName = Object.fromEntries(features.map((f) => [f.name, f]));

  // --- Vehicles --------------------------------------------------------------
  for (const v of demoVehicles) {
    const slug = slugify(`${v.year}-${v.make}-${v.model}`);
    const vehicle = await prisma.vehicle.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        vin: v.vin,
        licensePlate: v.plate,
        year: v.year,
        make: v.make,
        model: v.model,
        trim: v.trim,
        color: v.color,
        mileage: v.mileage,
        category: v.category,
        transmission: v.transmission,
        fuelType: v.fuelType,
        seats: v.seats,
        doors: v.doors,
        mpg: v.mpg,
        description: v.description,
        isDemo: true,
        dailyRateCents: v.dailyRateCents,
        weeklyRateCents: v.weeklyRateCents,
        monthlyRateCents: v.monthlyRateCents,
        securityDepositCents: v.securityDepositCents,
        registrationExpiresAt: new Date("2027-06-01"),
        insuranceExpiresAt: new Date("2027-03-01"),
        inspectionExpiresAt: new Date("2027-01-01"),
        images: {
          create: [0, 1, 2].map((i) => ({
            url: PLACEHOLDER[v.category],
            alt: `${v.year} ${v.make} ${v.model} — sample image`,
            position: i,
            isPrimary: i === 0,
          })),
        },
        availability: { create: {} },
        features: {
          create: featureNames
            .slice(0, 6)
            .map((name) => ({ featureId: featureByName[name].id })),
        },
      },
    });
    console.log(`  vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} (${vehicle.slug})`);
  }

  // --- Extras ------------------------------------------------------------------
  const extras: Array<{ name: string; description: string; chargeType: ExtraChargeType; amountCents?: number; percent?: number }> = [
    { name: "Additional Driver", description: "Add a second authorized driver to the rental agreement.", chargeType: ExtraChargeType.ONE_TIME, amountCents: 1500 },
    { name: "Child Seat", description: "Rear-facing or forward-facing child safety seat.", chargeType: ExtraChargeType.DAILY, amountCents: 800 },
    { name: "Prepaid Fuel", description: "Return the vehicle at any fuel level — no refueling required.", chargeType: ExtraChargeType.ONE_TIME, amountCents: 6000 },
    { name: "Extra Mileage Package", description: "+100 miles per day added to your mileage allowance.", chargeType: ExtraChargeType.DAILY, amountCents: 1200 },
    { name: "Airport Pickup", description: "We'll meet you at DFW or Dallas Love Field.", chargeType: ExtraChargeType.ONE_TIME, amountCents: 2500 },
    { name: "Airport Drop-off", description: "Convenient drop-off at DFW or Dallas Love Field.", chargeType: ExtraChargeType.ONE_TIME, amountCents: 2500 },
  ];
  for (const e of extras) {
    await prisma.extra.upsert({
      where: { id: slugify(e.name) },
      update: {},
      create: { id: slugify(e.name), ...e },
    });
  }

  // --- Coupon (inactive by default — admin must activate) ---------------------
  await prisma.coupon.upsert({
    where: { code: "WELCOME10" },
    update: {},
    create: {
      code: "WELCOME10",
      discountType: "PERCENTAGE",
      percent: 10,
      startsAt: new Date(),
      expiresAt: new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
      maxUses: 100,
      applicableVehicleIds: [],
      isActive: false,
    },
  });

  // --- Legal document placeholders ---------------------------------------------
  const legalDocs: Array<{ type: LegalDocumentType; title: string }> = [
    { type: LegalDocumentType.RENTAL_AGREEMENT, title: "Rental Agreement" },
    { type: LegalDocumentType.TERMS_AND_CONDITIONS, title: "Terms & Conditions" },
    { type: LegalDocumentType.PRIVACY_POLICY, title: "Privacy Policy" },
    { type: LegalDocumentType.CANCELLATION_POLICY, title: "Cancellation Policy" },
    { type: LegalDocumentType.INSURANCE_POLICY, title: "Insurance Policy" },
    { type: LegalDocumentType.DAMAGE_POLICY, title: "Damage Policy" },
    { type: LegalDocumentType.SECURITY_DEPOSIT_POLICY, title: "Security Deposit Policy" },
  ];
  for (const doc of legalDocs) {
    await prisma.legalDocument.upsert({
      where: { type: doc.type },
      update: {},
      create: {
        type: doc.type,
        title: doc.title,
        version: "v1-draft",
        needsAttorneyReview: true,
        content: `PLACEHOLDER — ${doc.title}\n\nThis is placeholder content generated for development purposes only. It has NOT been reviewed or approved by a licensed Texas attorney and must not be used in production. Replace this text in the admin dashboard (Settings, Legal Documents) with attorney-approved language before accepting real bookings or payments.`,
      },
    });
  }

  // --- FAQ -----------------------------------------------------------------------
  const faqData: Array<{ category: string; items: Array<{ q: string; a: string }> }> = [
    {
      category: "Rental Requirements",
      items: [
        { q: "What do I need to rent a car?", a: "PLACEHOLDER: A valid driver's license, a major credit or debit card, and meeting our minimum age requirement (configurable in Admin Settings). Final requirements are pending policy confirmation." },
        { q: "Is there a minimum age to rent?", a: "PLACEHOLDER: Minimum driver age is configured by the business in Admin Settings and will be displayed here once confirmed." },
      ],
    },
    {
      category: "Payments",
      items: [
        { q: "What payment methods do you accept?", a: "We accept major credit and debit cards, plus Apple Pay and Google Pay where supported, processed securely through Stripe." },
      ],
    },
    {
      category: "Deposits",
      items: [
        { q: "Is a security deposit required?", a: "PLACEHOLDER: Deposit amounts vary by vehicle and are shown during checkout. Deposit policy details are pending attorney review." },
      ],
    },
    {
      category: "Mileage",
      items: [
        { q: "How many miles are included?", a: "Each vehicle lists its daily mileage allowance and additional mileage fee on its vehicle detail page." },
      ],
    },
    {
      category: "Fuel",
      items: [
        { q: "Do I need to return the car with a full tank?", a: "PLACEHOLDER: Fuel policy is pending confirmation. A Prepaid Fuel option is available at checkout as an alternative." },
      ],
    },
    {
      category: "Pickup",
      items: [
        { q: "Where do I pick up my vehicle?", a: "PLACEHOLDER: Pickup location details will be confirmed in your booking confirmation email." },
      ],
    },
    {
      category: "Returns",
      items: [
        { q: "What happens if I return the car late?", a: "PLACEHOLDER: Late return policy and fees are pending confirmation and will be reflected in the Rental Agreement." },
      ],
    },
    {
      category: "Cancellations",
      items: [
        { q: "Can I cancel my reservation?", a: "PLACEHOLDER: Cancellation policy is pending attorney review. See the Cancellation Policy page for the current draft." },
      ],
    },
    {
      category: "Insurance",
      items: [
        { q: "Does rental insurance come included?", a: "PLACEHOLDER: Insurance requirements and options are pending confirmation. See the Insurance Policy page for the current draft." },
      ],
    },
    {
      category: "Accidents",
      items: [
        { q: "What do I do if I'm in an accident?", a: "PLACEHOLDER: Contact Rent A 4Wheel immediately and follow standard accident-reporting procedures. Full policy pending attorney review." },
      ],
    },
  ];
  let categoryPosition = 0;
  for (const cat of faqData) {
    const category = await prisma.faqCategory.upsert({
      where: { name: cat.category },
      update: {},
      create: { name: cat.category, position: categoryPosition++ },
    });
    let itemPosition = 0;
    for (const item of cat.items) {
      const existing = await prisma.faq.findFirst({ where: { categoryId: category.id, question: item.q } });
      if (!existing) {
        await prisma.faq.create({
          data: { categoryId: category.id, question: item.q, answer: item.a, position: itemPosition++ },
        });
      }
    }
  }

  // --- Reviews (demo, DB-managed — NOT fake Google reviews) --------------------
  const demoReviews = [
    { authorName: "Marcus T.", rating: 5, comment: "Smooth booking process and the car was spotless. Will rent again for my next trip to Dallas." },
    { authorName: "Priya K.", rating: 5, comment: "Needed a truck for a week to move — pricing was transparent and pickup was fast." },
    { authorName: "Sam R.", rating: 4, comment: "Great value compared to the airport counters. Only wish there were more SUV options available." },
  ];
  for (const r of demoReviews) {
    const existing = await prisma.review.findFirst({ where: { authorName: r.authorName, comment: r.comment } });
    if (!existing) {
      await prisma.review.create({
        data: { ...r, isPublished: true, isDemo: true },
      });
    }
  }

  // --- Site settings (admin editable, no-code) ----------------------------------
  const settings: Array<{ key: string; value: unknown }> = [
    { key: "businessName", value: "Rent A 4Wheel" },
    { key: "phone", value: "(214) 555-0123" },
    { key: "email", value: "hello@renta4wheel.com" },
    { key: "address", value: "Dallas, TX" },
    { key: "operatingHours", value: "Mon–Sat 8:00 AM – 7:00 PM, Sun 10:00 AM – 4:00 PM" },
    { key: "taxRatePercent", value: 8.25 },
    { key: "defaultDepositCents", value: 35000 },
    { key: "minimumAge", value: 21 },
    { key: "mileagePolicySummary", value: "Daily mileage allowance varies by vehicle; see vehicle details." },
    { key: "cancellationPolicySummary", value: "PLACEHOLDER — pending attorney review." },
    { key: "socialLinks", value: { instagram: "", facebook: "", tiktok: "" } },
  ];
  for (const s of settings) {
    await prisma.siteSetting.upsert({
      where: { key: s.key },
      update: {},
      create: { key: s.key, value: s.value as never },
    });
  }

  console.log("Seed complete.");
  console.log(`  Admin login: ${adminEmail} / ${adminPassword}`);
  console.log(`  Demo customer login: demo.customer@example.com / Demo1234!`);
  console.log(admin.id, demoCustomerUser.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
