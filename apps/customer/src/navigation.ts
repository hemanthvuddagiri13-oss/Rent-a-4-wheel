export type Routes = {
  Home: undefined; SignIn: undefined; Vehicle: { id: string }; Reservations: undefined;
  Reservation: { id: string }; Checkout: { id: string }; Inspection: { id: string };
  Inbox: undefined; Messages: { id: string }; Notices: undefined;
  Cases: { reservationId?: string } | undefined; Case: { id: string }; Review: { id: string }; Account: undefined;
};
