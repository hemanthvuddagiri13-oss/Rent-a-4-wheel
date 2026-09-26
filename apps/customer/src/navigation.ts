export type Routes = {
  Recovery: undefined; Home: undefined; SignIn: undefined; EmailSignIn: undefined; LoginMethods: undefined; Vehicle: { id: string }; Reservations: undefined;
  Reservation: { id: string }; Checkout: { id: string }; Inspection: { id: string; host?: boolean };
  HostFleet: undefined; HostVehicle: { id: string }; HostReservations: undefined;
  HostTrip: { id: string }; HostIdentity: { id: string }; HostEarnings: undefined; HostIncident: { id: string };
  Inbox: undefined; Messages: { id: string }; Notices: undefined;
  Cases: { reservationId?: string } | undefined; Case: { id: string }; Review: { id: string }; Account: undefined;
};
