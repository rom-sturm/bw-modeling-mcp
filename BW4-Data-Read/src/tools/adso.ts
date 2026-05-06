import { BwClient, MEDIA_TYPES } from '../bw-client.js';

const ADSO_ACCEPT = MEDIA_TYPES['adso'];

export async function bwGetAdso(client: BwClient, adsoName: string): Promise<string> {
  const path = `/sap/bw/modeling/adso/${adsoName.toLowerCase()}/m`;
  const result = await client.get(path, ADSO_ACCEPT);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  const ts = result.headers['timestamp'] ?? '';
  return `aDSO: ${adsoName.toUpperCase()}\nStatus: ${status}\nTimestamp: ${ts}\n\n${result.body}`;
}
