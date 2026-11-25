import { createHash, randomBytes } from 'node:crypto';

import { AppError } from './errors.mjs';
import { checkFacts, descriptionHtml, previewText, readFacts } from './facts.mjs';
import { requireProductId } from './clients.mjs';

const reviewLifetime = 60 * 60_000;
const flagReasons = new Set(['inaccurate', 'inappropriate', 'other']);

function fingerprint(product) {
  return createHash('sha256').update(JSON.stringify([
    product.id, product.title, product.bodyHtml, product.updatedAt,
  ])).digest('hex');
}

function publicReview(review) {
  const { id, productId, title, current, draft, findings, revision, flagged, receipt } = review;
  return { id, productId, title, current, draft, findings, revision, flagged, receipt };
}

function assertRevision(review, request) {
  if (!Number.isSafeInteger(request.revision) || request.revision !== review.revision) {
    throw new AppError(409, 'This preview changed. Refresh it before continuing.');
  }
}

export function reviewService({ store, generator, recordFlag, now = Date.now }) {
  const drafts = new Map();
  const writing = new Set();

  function get(id) {
    const review = drafts.get(id);
    if (!review || review.expiresAt <= now()) {
      throw new AppError(404, 'This draft expired. Generate a fresh preview.');
    }
    return review;
  }

  function available(review) {
    if (review.busy) throw new AppError(409, 'This draft has another action in progress.');
  }

  return {
    async generate(input) {
      const productId = requireProductId(input.productId);
      if (typeof input.model !== 'string' || !input.model || input.model.length > 500) {
        throw new AppError(400, 'Choose a text model.');
      }
      const facts = readFacts(input);
      for (const [id, review] of drafts) {
        if (review.expiresAt <= now() && !review.busy) drafts.delete(id);
      }
      if (drafts.size >= 200) throw new AppError(503, 'Draft storage is full. Try again later.');
      const product = await store.get(productId);
      const draft = await generator.generate({ title: product.title, facts, model: input.model });
      if (drafts.size >= 200) throw new AppError(503, 'Draft storage is full. Try again later.');
      const review = {
        id: randomBytes(24).toString('base64url'),
        productId,
        title: product.title,
        current: previewText(product.bodyHtml).slice(0, 15000),
        original: fingerprint(product),
        facts,
        draft,
        findings: checkFacts(facts, draft),
        revision: 1,
        flagged: false,
        receipt: null,
        busy: false,
        expiresAt: now() + reviewLifetime,
      };
      drafts.set(review.id, review);
      return publicReview(review);
    },
    edit(id, input) {
      const review = get(id);
      assertRevision(review, input);
      available(review);
      if (review.receipt) throw new AppError(409, 'Start a new draft to make further changes.');
      if (typeof input.draft !== 'string' || input.draft.length > 5000) {
        throw new AppError(400, 'Enter up to 5,000 characters of plain text.');
      }
      const draft = input.draft.trim();
      if (review.flagged && draft === review.draft) {
        throw new AppError(409, 'Change the flagged draft before checking it again.');
      }
      review.draft = draft;
      review.findings = checkFacts(review.facts, draft);
      review.revision += 1;
      review.flagged = false;
      return publicReview(review);
    },
    async flag(id, input) {
      const review = get(id);
      assertRevision(review, input);
      available(review);
      if (!flagReasons.has(input.reason)) throw new AppError(400, 'Choose a reason to flag this draft.');
      if (review.flagged) return publicReview(review);

      review.busy = true;
      try {
        await recordFlag({
          timestamp: new Date(now()).toISOString(),
          productId: review.productId,
          revision: review.revision,
          reason: input.reason,
        });
        review.flagged = true;
        return publicReview(review);
      } finally {
        review.busy = false;
      }
    },
    async apply(id, input) {
      const review = get(id);
      assertRevision(review, input);
      if (input.confirm !== true) throw new AppError(400, 'Confirm the description replacement.');
      if (review.receipt) return publicReview(review);
      available(review);
      if (review.flagged || review.findings.length) {
        throw new AppError(409, 'Resolve all findings and check the draft before applying it.');
      }
      if (writing.has(review.productId)) {
        throw new AppError(409, 'A description update for this product is already in progress.');
      }

      const html = descriptionHtml(review.draft);
      review.busy = true;
      writing.add(review.productId);
      try {
        const current = await store.get(review.productId);
        if (current.bodyHtml !== html) {
          if (fingerprint(current) !== review.original) {
            throw new AppError(409, 'The product changed in SHOPLINE. Generate a fresh preview.');
          }
          await store.updateDescription(review.productId, html);
          const saved = await store.get(review.productId);
          if (saved.bodyHtml !== html) {
            throw new AppError(502, 'Could not verify the saved description. Check SHOPLINE before retrying.');
          }
        }
        review.receipt = { savedAt: new Date(now()).toISOString() };
        return publicReview(review);
      } finally {
        review.busy = false;
        writing.delete(review.productId);
      }
    },
  };
}
