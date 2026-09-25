/** Stable mapping: changing these names would strand existing server receipts. */
export const mutationOperations = {
  hold: 'reservation.hold', checkout: 'reservation.checkout', hostAvailability: 'host.availability',
  openConversation: 'conversation.open', saveReview: 'review.save', sendMessage: 'message.send',
  replyCase: 'case.reply', openCase: 'case.open', submitReport: 'report.submit', acceptReport: 'report.accept',
  hostHandoff: 'host.handoff', tripStart: 'reservation.start', tripReturn: 'reservation.return',
  tripCancel: 'reservation.cancel', tripKeys: 'reservation.keys', tripComplete: 'reservation.complete',
} as const;
export type RecoverableOperation = keyof typeof mutationOperations;
