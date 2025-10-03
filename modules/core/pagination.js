/**
 * 简易分页窗口生成工具
 * buildPageWindow(current, total, radius=2)
 * 返回一个按顺序的数组，比如 current=5,total=12,radius=2 -> [3,4,5,6,7]
 */
export function buildPageWindow(pageIndex, pageTotal, radius = 2) {
  pageIndex = Number(pageIndex) || 1;
  pageTotal = Number(pageTotal) || 1;
  if (pageIndex < 1) pageIndex = 1;
  if (pageTotal < 1) pageTotal = 1;
  if (pageIndex > pageTotal) pageIndex = pageTotal;

  const start = Math.max(1, pageIndex - radius);
  const end = Math.min(pageTotal, pageIndex + radius);
  const arr = [];
  for (let i = start; i <= end; i++) arr.push(i);
  return arr;
}

/**
 * 可选：生成包含首尾省略符的结构
 * buildPageWindowAdvanced(5,12,2) =>
 * { pages:[1,'...',3,4,5,6,7,'...',12], current:5 }
 */
export function buildPageWindowAdvanced(pageIndex, pageTotal, radius = 2) {
  const core = buildPageWindow(pageIndex, pageTotal, radius);
  if (core.length === 0) return { pages: [], current: pageIndex };

  const pages = [];
  const firstCore = core[0];
  const lastCore = core[core.length - 1];

  if (firstCore > 1) {
    pages.push(1);
    if (firstCore > 2) pages.push('...');
  }
  pages.push(...core);
  if (lastCore < pageTotal) {
    if (lastCore < pageTotal - 1) pages.push('...');
    pages.push(pageTotal);
  }
  return { pages, current: pageIndex };
}