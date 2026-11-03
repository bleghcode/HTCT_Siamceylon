import { handle } from '../_shared/contracts.js';

// GET /api/search?query=...  (โรงแรม)
export const onRequestGet = (context) => handle(context, 'hotel');
