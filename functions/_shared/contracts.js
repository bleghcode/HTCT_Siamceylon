// ตัวช่วยกลาง ใช้ร่วมกันทั้ง Hotel และ Tour (Cloudflare Pages Functions)
// ชื่อคอลัมน์ใส่เป็นรายการได้ จะใช้ชื่อแรกที่เจอใน Notion
// แต่ละฝั่งใช้ integration (key) และ database ของตัวเอง ตั้งค่าไว้ใน Cloudflare Variables

const SOURCES = {
  hotel: {
    keyEnv: 'NOTION_KEY',
    dbEnv: 'NOTION_DATABASE_ID',
    props: { name: ['Hotel'], location: ['Location'], supplier: [], exp: ['EXP'], files: ['Files & media'] },
    searchIn: ['name', 'location'],
    noDate: 'Request Rate', // ข้อความเมื่อไม่มีวันหมดอายุ
  },
  tour: {
    keyEnv: 'NOTION_TOUR_KEY',
    dbEnv: 'NOTION_TOUR_DATABASE_ID',
    props: { name: ['Tour'], location: ['Location'], supplier: [], exp: ['EXP'], files: ['Files & media'] },
    searchIn: ['name', 'location'],
    noDate: 'Request Rate',
  },
};

// ดึงข้อมูลทุกหน้า (รองรับเกิน 100 รายการ)
async function fetchAllPages(dbId, notionKey) {
  let pages = [];
  let cursor;
  do {
    const response = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Error fetching from Notion');
    pages = pages.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function getProp(props, names) {
  for (const n of names || []) if (props[n]) return props[n];
  return undefined;
}

// รายการไฟล์ของหน้านั้น (ใช้ทั้งตอนค้นหา และตอนกดเปิดไฟล์ เพื่อให้ลำดับตรงกัน)
function extractFiles(props, cfg) {
  return (getProp(props, cfg.props.files)?.files || [])
    .map((f) => ({ name: f.name, url: f.file?.url || f.external?.url }))
    .filter((f) => f.url);
}

function readText(prop) {
  if (!prop) return '';
  if (prop.title) return prop.title.map((t) => t.plain_text).join('');
  if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join('');
  if (prop.select) return prop.select.name || '';
  if (prop.multi_select) return prop.multi_select.map((s) => s.name).join(', ');
  return '';
}

function toItem(page, cfg) {
  const p = page.properties;
  const name = readText(getProp(p, cfg.props.name)).trim();
  if (!name) return null; // ข้ามแถวว่างที่ยังไม่ได้ตั้งชื่อ

  const files = extractFiles(p, cfg);

  const expiryISO = getProp(p, cfg.props.exp)?.date?.start?.slice(0, 10) || null;
  let expiryDate = cfg.noDate;
  if (expiryISO) {
    const [yyyy, mm, dd] = expiryISO.split('-');
    expiryDate = `${dd}/${mm}/${yyyy}`;
  }

  return {
    id: page.id,
    name,
    location: readText(getProp(p, cfg.props.location)),
    supplier: readText(getProp(p, cfg.props.supplier)),
    files,
    contractUrl: files[0]?.url || '#',
    expiryDate,
    expiryISO,
    updatedAt: page.last_edited_time || null, // วันที่แก้ไขหน้านี้ล่าสุดใน Notion
  };
}

// cache 60 วินาที (ลิงก์ไฟล์ Notion หมดอายุใน ~1 ชม. จึงไม่ควร cache นาน)
const CACHE_MS = 60 * 1000;
const cache = {};

function filterItems(items, cfg, query) {
  const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((it) => {
    const haystack = cfg.searchIn.map((k) => it[k] || '').join(' ').toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

// เปิดไฟล์: ดึงลิงก์ไฟล์ "สด" จาก Notion ตอนกด แล้วส่งต่อไปที่ลิงก์นั้น
// (ลิงก์ที่ Notion ให้หมดอายุใน ~1 ชม. จึงไม่ใช้ลิงก์ที่เก็บไว้ในหน้าเว็บ)
export async function handleFile(context) {
  const json = (status, obj) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  try {
    const { env, request } = context;
    const sp = new URL(request.url).searchParams;
    const cfg = SOURCES[sp.get('type')];
    const id = sp.get('id') || '';
    const index = Number(sp.get('i') || 0);
    if (!cfg) return json(400, { error: 'Invalid type' });
    if (!/^[0-9a-f-]{32,36}$/i.test(id)) return json(400, { error: 'Invalid id' });
    if (!Number.isInteger(index) || index < 0) return json(400, { error: 'Invalid file index' });

    const notionKey = env[cfg.keyEnv];
    const dbId = env[cfg.dbEnv];
    if (!notionKey) throw new Error(`Missing ${cfg.keyEnv} in Cloudflare variables`);
    if (!dbId) throw new Error(`Missing ${cfg.dbEnv} in Cloudflare variables`);

    const response = await fetch(`https://api.notion.com/v1/pages/${id}`, {
      headers: { Authorization: `Bearer ${notionKey}`, 'Notion-Version': '2022-06-28' },
    });
    const page = await response.json();
    if (!response.ok) throw new Error(page.message || 'Error fetching from Notion');

    // ต้องเป็นหน้าใน database นี้เท่านั้น (กันการใช้ endpoint นี้ดึงไฟล์จากหน้าอื่น)
    const pageDb = (page.parent?.database_id || '').replace(/-/g, '');
    if (page.archived || pageDb !== dbId.replace(/-/g, '')) return json(404, { error: 'File not found' });

    const file = extractFiles(page.properties, cfg)[index];
    if (!file || !/^https?:\/\//i.test(file.url)) return json(404, { error: 'File not found' });

    return new Response(null, { status: 302, headers: { Location: file.url, 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('File Error:', error.message);
    return json(500, { error: error.message });
  }
}

export async function handle(context, type) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };
  try {
    const cfg = SOURCES[type];
    const { env, request } = context;
    const notionKey = env[cfg.keyEnv];
    const dbId = env[cfg.dbEnv];
    if (!notionKey) throw new Error(`Missing ${cfg.keyEnv} in Cloudflare variables`);
    if (!dbId) throw new Error(`Missing ${cfg.dbEnv} in Cloudflare variables`);

    let items;
    const hit = cache[type];
    if (hit && hit.dbId === dbId && Date.now() - hit.time < CACHE_MS) {
      items = hit.items;
    } else {
      const pages = await fetchAllPages(dbId, notionKey);
      items = pages.map((pg) => toItem(pg, cfg)).filter(Boolean);
      cache[type] = { dbId, time: Date.now(), items };
    }

    const query = new URL(request.url).searchParams.get('query');
    // ตัดแถวที่ ID ซ้ำกันออก (เหมือนของเดิม)
    const unique = Array.from(new Map(filterItems(items, cfg, query).map((it) => [it.id, it])).values());
    return new Response(JSON.stringify(unique), { headers });
  } catch (error) {
    console.error('API Error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}
