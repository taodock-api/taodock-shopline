import { AppError } from './errors.mjs';

// Unit groups mirror the Taodock AI Verify catalogue audit.
const units = new Map([
  ['mm', ['length', 1n]], ['cm', ['length', 10n]], ['m', ['length', 1000n]],
  ['g', ['weight', 1n]], ['kg', ['weight', 1000n]],
  ['ml', ['volume', 1n]], ['l', ['volume', 1000n]],
  ['w', ['power', 1n]], ['kw', ['power', 1000n]],
  ['minute', ['duration', 1n]], ['minutes', ['duration', 1n]],
  ['min', ['duration', 1n]], ['mins', ['duration', 1n]],
  ['hour', ['duration', 60n]], ['hours', ['duration', 60n]],
  ['hr', ['duration', 60n]], ['hrs', ['duration', 60n]],
  ['piece', ['count', 1n]], ['pieces', ['count', 1n]],
  ['pc', ['count', 1n]], ['pcs', ['count', 1n]], ['%', ['percentage', 1n]],
]);
const unitPattern = [...units.keys()].sort((left, right) => right.length - left.length).join('|');
const numberPattern = String.raw`[+\-−]?(?:[0-9]{1,3}(?:,[0-9]{3}){1,3}|[0-9]{1,12})(?:\.[0-9]{1,9})?`;
const quantity = String.raw`(?<value>${numberPattern})\s*(?<unit>${unitPattern})`;
const wholeQuantity = new RegExp(`^${quantity}$`, 'u');
const embeddedQuantity = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.,/+\-−])${quantity}(?![\p{L}\p{N}_%])`,
  'gu',
);

function normalise(text) {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function measurementKey({ value, unit }) {
  const [group, factor] = units.get(unit);
  const [whole, decimal = ''] = value.replaceAll(',', '').replace('−', '-').split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  const digits = whole.replace(/^[+-]/u, '') + decimal.padEnd(9, '0');
  return `${group}:${sign * BigInt(digits) * factor}`;
}

function rules(value, label) {
  if (typeof value !== 'string' || value.length > 2500) {
    throw new AppError(400, `${label} must be text under 2,500 characters.`);
  }
  const parts = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (parts.length > 20 || parts.some((part) => part.length > 100)) {
    throw new AppError(400, `Enter up to 20 ${label.toLowerCase()}, one per line.`);
  }
  return parts;
}

export function readFacts(input) {
  const measurements = rules(input.measurements, 'Measurements');
  const phrases = rules(input.phrases, 'Required phrases');
  if (measurements.length + phrases.length === 0) {
    throw new AppError(400, 'Enter at least one approved measurement or required phrase.');
  }
  return {
    measurements: new Map(measurements.map((label) => {
      const parsed = wholeQuantity.exec(normalise(label));
      if (!parsed) {
        throw new AppError(400, 'Use one number and supported unit per line, such as 500 ml.');
      }
      return [measurementKey(parsed.groups), label];
    })),
    phrases: [...new Map(phrases.map((phrase) => [normalise(phrase), phrase])).values()],
  };
}

export function checkFacts(facts, draft) {
  const text = normalise(draft);
  if (!text) return [{ kind: 'empty', value: '' }];

  const seen = new Map([...text.matchAll(embeddedQuantity)].map((match) => [
    measurementKey(match.groups),
    match[0],
  ]));
  const findings = [];
  for (const [key, label] of facts.measurements) {
    if (!seen.has(key)) findings.push({ kind: 'missing', value: label });
  }
  for (const [key, token] of seen) {
    if (!facts.measurements.has(key)) findings.push({ kind: 'extra', value: token });
  }
  for (const phrase of facts.phrases) {
    const literal = normalise(phrase).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}_])${literal}(?![\p{L}\p{N}_])`, 'u');
    if (!pattern.test(text)) findings.push({ kind: 'phrase', value: phrase });
  }
  return findings;
}

export function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function descriptionHtml(draft) {
  return draft.trim().split(/\n\s*\n/u).map((paragraph) => (
    `<p>${escapeHtml(paragraph).replace(/\r?\n/gu, '<br>')}</p>`
  )).join('\n');
}

export function previewText(html) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
    .replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/giu, (match, entity) => {
      if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
      const hex = entity[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .trim();
}
