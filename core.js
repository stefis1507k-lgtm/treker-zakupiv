// Логіка трекера: гроші, підсумки, шифрування, зберігання у GitHub.
// Працює і в браузері, і в Node (для тестів).

export const REPO = { owner: "stefis1507k-lgtm", name: "treker-zakupiv", branch: "main", dataPath: "data/ledger.json" };

// ---------- Гроші (цілі гроші, без float) ----------
export function toGrosz(value) {
  const s = String(value).trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error("Некоректна сума");
  const [whole, fraction = ""] = s.split(".");
  const g = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (g <= 0) throw new Error("Сума має бути більшою за 0");
  return g;
}

export function formatPln(grosz, { sign = true } = {}) {
  const s = !sign ? "" : grosz > 0 ? "+" : grosz < 0 ? "−" : "";
  const abs = Math.abs(grosz);
  const zl = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${s}${zl},${String(abs % 100).padStart(2, "0")} zł`;
}

export function calculateBalance(entries) {
  return entries.reduce((t, e) => t + (e.type === "income" ? e.amountGrosz : -e.amountGrosz), 0);
}

export function entriesOfMonth(entries, month) {
  return entries.filter((e) => e.date.startsWith(month));
}

export function summarizeMonth(entries, month) {
  const byCategory = {};
  let purchases = 0, income = 0;
  for (const e of entriesOfMonth(entries, month)) {
    if (e.type === "income") income += e.amountGrosz;
    else {
      purchases += e.amountGrosz;
      byCategory[e.categoryId] = (byCategory[e.categoryId] ?? 0) + e.amountGrosz;
    }
  }
  return { byCategory, purchases, income };
}

// Видимі на головному екрані: не приховані + приховані, що мають закупи в цьому місяці.
export function categoriesForMonth(categories, byCategory) {
  return categories
    .filter((c) => !c.hidden || byCategory[c.id])
    .sort((a, b) => a.order - b.order);
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
export function monthLabel(month) {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// ---------- Операції з даними (чисті функції) ----------
export function validateEntry(input, categories) {
  if (input.type !== "income" && input.type !== "purchase") throw new Error("Невідомий тип запису");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Вкажи дату");
  if (!Number.isInteger(input.amountGrosz) || input.amountGrosz <= 0) throw new Error("Сума має бути більшою за 0");
  if (input.type === "purchase" && !categories.some((c) => c.id === input.categoryId)) throw new Error("Обери категорію");
}

export function applyOp(data, op) {
  const d = structuredClone(data);
  const now = new Date().toISOString();
  switch (op.kind) {
    case "addEntry": {
      validateEntry(op.entry, d.categories);
      d.entries.push({ ...op.entry, categoryId: op.entry.type === "purchase" ? op.entry.categoryId : null, createdAt: now, updatedAt: now });
      break;
    }
    case "updateEntry": {
      const i = d.entries.findIndex((e) => e.id === op.entry.id);
      if (i < 0) throw new Error("Запис уже видалено");
      validateEntry(op.entry, d.categories);
      d.entries[i] = { ...d.entries[i], ...op.entry, categoryId: op.entry.type === "purchase" ? op.entry.categoryId : null, updatedAt: now };
      break;
    }
    case "deleteEntry":
      d.entries = d.entries.filter((e) => e.id !== op.id);
      break;
    case "saveCategory": {
      const name = String(op.category.name ?? "").trim();
      if (!name) throw new Error("Вкажи назву категорії");
      const i = d.categories.findIndex((c) => c.id === op.category.id);
      if (i < 0) d.categories.push({ image: "", hidden: false, order: Math.max(0, ...d.categories.map((c) => c.order)) + 1, createdAt: now, ...op.category, name });
      else d.categories[i] = { ...d.categories[i], ...op.category, name };
      break;
    }
    case "moveCategory": {
      const list = d.categories.slice().sort((a, b) => a.order - b.order);
      const i = list.findIndex((c) => c.id === op.id), j = i + op.delta;
      if (i < 0 || j < 0 || j >= list.length) break;
      [list[i], list[j]] = [list[j], list[i]];
      list.forEach((c, k) => (c.order = k + 1));
      d.categories = list;
      break;
    }
    default:
      throw new Error("Невідома дія");
  }
  return d;
}

export function newId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// ---------- Шифрування (AES-GCM, ключ живе лише в посиланні після #) ----------
const enc = new TextEncoder(), dec = new TextDecoder();
export const b64 = {
  from: (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); },
  to: (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)),
};
const b64url = {
  from: (bytes) => b64.from(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  to: (s) => b64.to(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)),
};

export function generateKeyString() {
  return b64url.from(crypto.getRandomValues(new Uint8Array(32)));
}

async function importKey(keyString) {
  const raw = b64url.to(keyString);
  if (raw.length !== 32) throw new Error("Неправильний ключ у посиланні");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptData(data, keyString) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyString), enc.encode(JSON.stringify(data))));
  return JSON.stringify({ v: 1, iv: b64.from(iv), ct: b64.from(ct) });
}

export async function decryptData(fileText, keyString) {
  const f = JSON.parse(fileText);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.to(f.iv) }, await importKey(keyString), b64.to(f.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error("Ключ у посиланні не підходить");
  }
}

// UTF-8 текст <-> base64 для GitHub Contents API
export const utf8b64 = {
  from: (text) => b64.from(enc.encode(text)),
  to: (s) => dec.decode(b64.to(s.replace(/\s/g, ""))),
};

// ---------- GitHub ----------
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/`;

function ghHeaders(token) {
  const h = { Accept: "application/vnd.github+json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function loadRemote(keyString, token, fetchImpl = fetch) {
  const r = await fetchImpl(`${API}${REPO.dataPath}?ref=${REPO.branch}&t=${Date.now()}`, { headers: ghHeaders(token), cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 403 ? "GitHub тимчасово обмежив запити. Спробуй за кілька хвилин" : `Не вдалося завантажити дані (${r.status})`);
  const j = await r.json();
  return { data: await decryptData(utf8b64.to(j.content), keyString), sha: j.sha };
}

async function putFile(path, base64Content, message, token, sha, fetchImpl) {
  const body = { message, content: base64Content, branch: REPO.branch };
  if (sha) body.sha = sha;
  return fetchImpl(API + path, { method: "PUT", headers: { ...ghHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// Застосовує операцію до найсвіжіших даних і зберігає. При конфлікті версій — перечитує й повторює.
export async function commitOp(op, keyString, token, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, sha } = await loadRemote(keyString, token, fetchImpl);
    const next = applyOp(data, op);
    const r = await putFile(REPO.dataPath, utf8b64.from(await encryptData(next, keyString)), "Оновлення записів", token, sha, fetchImpl);
    if (r.ok) return { data: next, sha: (await r.json()).content.sha };
    if (r.status === 409 || r.status === 422) continue;
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error("Немає дозволу на зміну. Перевір ключ керування");
    throw new Error(`Не збережено (${r.status})`);
  }
  throw new Error("Не збережено: дані змінилися. Спробуй ще раз");
}

export async function uploadPhoto(path, base64Jpeg, token, fetchImpl = fetch) {
  const r = await putFile(path, base64Jpeg, "Фото категорії", token, null, fetchImpl);
  if (!r.ok) throw new Error(`Фото не завантажено (${r.status})`);
}

export async function checkToken(token, fetchImpl = fetch) {
  const r = await fetchImpl(`https://api.github.com/repos/${REPO.owner}/${REPO.name}`, { headers: ghHeaders(token) });
  if (!r.ok) return false;
  const j = await r.json();
  return Boolean(j.permissions?.push);
}

export function imageUrl(image) {
  if (!image) return "";
  if (/^https?:/.test(image)) return image;
  return `https://raw.githubusercontent.com/${REPO.owner}/${REPO.name}/${REPO.branch}/${image}`;
}
