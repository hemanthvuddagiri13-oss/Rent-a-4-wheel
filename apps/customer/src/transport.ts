import { trace, traceOperation, timingRequestId } from './acceptance-trace';
import { createBoundedFetch } from '../../../packages/mobile-client/src/bounded-fetch';
export const boundedFetch = createBoundedFetch((...args) => fetch(...args), { trace, traceOperation, timingRequestId });
