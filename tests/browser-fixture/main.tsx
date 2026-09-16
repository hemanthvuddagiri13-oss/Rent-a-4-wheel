import React from "react";
import { createRoot } from "react-dom/client";
import { BookingWizard } from "../../src/components/booking/booking-wizard";
createRoot(document.getElementById("root")!).render(<BookingWizard vehicle={{id:"browser-vehicle",slug:"browser",year:2025,make:"Test",model:"Car",trim:null,dailyRateCents:5000,weeklyRateCents:30000,monthlyRateCents:90000,securityDepositCents:0,imageUrl:null}} extras={[]} />);
