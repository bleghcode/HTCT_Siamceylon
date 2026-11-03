import { handle } from '../../_shared/contracts.js';

// GET /api/tours/search?query=...  (ทัวร์)
export const onRequestGet = (context) => handle(context, 'tour');
