import { AppError } from './errors.mjs';
import { escapeHtml } from './facts.mjs';

const samples = [
  ['901', 'SG-001', 'Harbour insulated bottle', '500 ml', 'stainless steel\nnavy blue',
    'A navy blue stainless steel bottle with a 500 mL capacity.'],
  ['902', 'SG-002', 'Tiong Bahru silicone tray', '1 kg', 'food-grade silicone',
    'A food-grade silicone tray for up to 900 g.'],
  ['903', 'SG-003', 'East Coast bamboo board', '30 cm\n60 cm', 'solid bamboo',
    'A solid bamboo board measuring 300 mm by 0.6 m.'],
  ['904', 'SG-004', 'Katong kitchen cloth set', '4 pieces', 'organic cotton',
    'A set of 4 pieces in organic cotton with a bonus 50 g pouch.'],
  ['905', 'SG-005', 'Punggol rechargeable light', '60 min', 'USB-C',
    'A USB-C rechargeable light with a 1 hour runtime.'],
  ['906', 'SG-006', 'Orchard desk lamp', '15 W', 'matte white',
    'A white desk lamp rated at 15 W.'],
];

export function demoClients() {
  const products = new Map(samples.map(([id, spu, title, measurements, phrases, draft], index) => [
    id,
    {
      id, spu, title, measurements, phrases, draft,
      status: index > 3 ? 'draft' : 'active',
      bodyHtml: `<p>${escapeHtml(title)}.</p><p>${measurements.replaceAll('\n', ', ')}. ${phrases.replaceAll('\n', ', ')}.</p>`,
      updatedAt: '2026-11-25T00:00:00Z',
    },
  ]));
  const reports = [];
  return {
    store: {
      async list({ title }) {
        return {
          products: [...products.values()].filter((product) => (
            product.title.toLowerCase().includes(title.toLowerCase())
          )).map(({ bodyHtml, updatedAt, draft, ...product }) => product),
          next: '',
        };
      },
      async get(id) {
        const product = products.get(id);
        if (!product) throw new AppError(404, 'Demo product not found.');
        return { ...product };
      },
      async updateDescription(id, html) {
        const product = products.get(id);
        product.bodyHtml = html;
        product.updatedAt = new Date().toISOString();
      },
    },
    generator: {
      async models() { return ['catalog-demo']; },
      async generate({ title, model }) {
        if (model !== 'catalog-demo') throw new AppError(400, 'Choose the sample model.');
        return [...products.values()].find((product) => product.title === title).draft;
      },
    },
    async recordFlag(report) { reports.push(report); },
  };
}
