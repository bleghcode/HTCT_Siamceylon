import { handleFile } from '../_shared/contracts.js';

// GET /api/file?type=hotel|tour&id=<page id>&i=<ลำดับไฟล์>  → ส่งต่อไปที่ลิงก์ไฟล์สดจาก Notion
export const onRequestGet = (context) => handleFile(context);
