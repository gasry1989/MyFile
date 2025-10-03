// 轻量模板加载器：按 URL 拉取 HTML，按 templateId 取出 <template>，缓存解析结果
const __tplCache = new Map(); // url -> { doc, tmpls: Map<id, HTMLTemplateElement> }

export async function importTemplate(url, templateId) {
  let rec = __tplCache.get(url);
  if (!rec) {
    const html = await fetch(url, { cache: 'no-cache' }).then(r => {
      if (!r.ok) throw new Error(`Failed to load template: ${url}`);
      return r.text();
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tmpls = new Map();
    doc.querySelectorAll('template[id]').forEach(t => tmpls.set(t.id, t));
    rec = { doc, tmpls };
    __tplCache.set(url, rec);
  }
  const tpl = templateId ? rec.tmpls.get(templateId) : rec.doc.querySelector('template');
  if (!tpl) throw new Error(`Template #${templateId || '(first)'} not found in ${url}`);
  return tpl.content.cloneNode(true);
}