import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pendingRequests, recoverRequest, friendly } from '../runtime';
import { Page, Card, Copy, Hint, Button, Busy, ErrorText } from '../ui';
import { useAction } from '../hooks';
import { useCaptureProtection } from '../screen-privacy';
const labels: Record<string, string> = { sendMessage: 'Message', replyCase: 'Support reply', openCase: 'Support request', submitReport: 'Condition report', acceptReport: 'Report acceptance', hostHandoff: 'Identity comparison', tripStart: 'Trip start', tripReturn: 'Begin return', tripCancel: 'Cancellation', tripKeys: 'Keys handoff', tripComplete: 'Complete return', privateUpload: 'Private photo upload' };
export function Recovery() {
  const protectedScreen = useCaptureProtection(), action = useAction(), queries = useQueryClient();
  const [confirmed, setConfirmed] = useState('');
  const q = useQuery({ queryKey: ['pendingRequests'], queryFn: pendingRequests });
  if (!protectedScreen) return <Page title="Private screen"><Hint>Preparing screen protection.</Hint></Page>;
  return <Page title="Interrupted requests"><Hint>Nothing is sent automatically. Recover the original request only if you still intend it. The server checks current access and trip requirements, and reuses the original request identity. A conflict needs review in the original screen.</Hint><Button title="Refresh interrupted requests" onPress={() => void q.refetch()} />{q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : !q.data.length ? <Copy>No interrupted requests for this account.</Copy> : q.data.map(record => <Card key={record.key}><Copy>{labels[record.operation] ?? 'Request'}</Copy><Hint>Started {new Date(record.createdAt).toLocaleString()}</Hint><Hint>Open the original conversation or trip to review its current state before recovering.</Hint><Button testID={'recover-' + record.operation} title={`Recover ${labels[record.operation] ?? 'request'}`} disabled={action.busy || record.operation === 'privateUpload'} onPress={() => void action.run(async () => { await recoverRequest(record); setConfirmed('Server acknowledged ' + record.operation + '. Open the original screen to verify its current state.'); await queries.invalidateQueries(); })} /></Card>)}<ErrorText message={action.error} /><Hint>{confirmed}</Hint><Hint>For an interrupted photo upload, return to its original screen and select the same photo. Private image bytes are not saved in this recovery list.</Hint></Page>;
}
