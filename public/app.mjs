const find = (id) => document.getElementById(id);
const selected = new Map();
const limit = 5;
const model = find('model');
const generate = find('generate');
const operation = find('operation');
const catalogState = find('catalog-state');
const nextPage = find('next-page');
let cursor = '';
let searchTitle = '';
let lastSearch = 0;
let batching = false;

async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}

function status(element, text, failed = false) {
  element.textContent = text;
  element.toggleAttribute('data-error', failed);
}

function updateControls() {
  find('selection-count').textContent = `${selected.size} of ${limit} selected`;
  find('empty').hidden = selected.size > 0;
  generate.disabled = batching || !model.value || ![...selected.values()].some((item) => !item.review);
  for (const toggle of find('products').querySelectorAll('input')) {
    const item = selected.get(toggle.value);
    toggle.checked = Boolean(item);
    toggle.disabled = Boolean(item?.busy) || (!item && selected.size >= limit);
  }
}

function paintProducts(products) {
  const fragment = document.createDocumentFragment();
  for (const product of products) {
    const option = find('product-template').content.cloneNode(true);
    const toggle = option.querySelector('input');
    toggle.value = product.id;
    option.querySelector('strong').textContent = product.title;
    option.querySelector('small').textContent = [product.spu || product.id, product.status]
      .filter(Boolean).join(' · ');
    toggle.addEventListener('change', () => {
      if (toggle.checked) addProduct(product);
      else removeProduct(product.id);
    });
    fragment.append(option);
  }
  find('products').replaceChildren(fragment);
  updateControls();
}

async function loadProducts(title, pageCursor = '') {
  const sequence = ++lastSearch;
  nextPage.disabled = true;
  status(catalogState, 'Loading products…');
  try {
    const params = new URLSearchParams({ title, cursor: pageCursor });
    const result = await api(`/api/products?${params}`);
    if (sequence !== lastSearch) return;
    searchTitle = title;
    cursor = result.next;
    const mode = find('mode');
    mode.textContent = result.demo ? 'Demo store' : 'Connected store';
    mode.hidden = false;
    paintProducts(result.products);
    status(catalogState, result.products.length ? '' : 'No products found.');
    nextPage.hidden = !cursor;
  } catch (error) {
    if (sequence !== lastSearch) return;
    status(catalogState, error.message, true);
  } finally {
    if (sequence === lastSearch) nextPage.disabled = false;
  }
}

async function loadModels() {
  try {
    const { models } = await api('/api/models');
    const placeholder = new Option('Choose a text model', '');
    placeholder.disabled = true;
    model.replaceChildren(placeholder, ...models.map((id) => new Option(id, id)));
    model.value = models.length === 1 ? models[0] : '';
    model.disabled = models.length === 0;
    if (!models.length) status(operation, 'This key has no available models.', true);
  } catch (error) {
    status(operation, error.message, true);
  } finally {
    updateControls();
  }
}

function addProduct(product) {
  if (selected.size >= limit || selected.has(product.id)) return;
  const fragment = find('card-template').content.cloneNode(true);
  const element = fragment.querySelector('article');
  const fields = Object.fromEntries(
    [...element.querySelectorAll('[data-field]')].map((entry) => [entry.dataset.field, entry]),
  );
  const actions = Object.fromEntries(
    [...element.querySelectorAll('[data-action]')].map((entry) => [entry.dataset.action, entry]),
  );
  const item = { product, element, fields, actions, review: null, busy: false };
  fields.title.textContent = product.title;
  fields.measurements.value = product.measurements ?? '';
  fields.phrases.value = product.phrases ?? '';
  actions.remove.addEventListener('click', () => removeProduct(product.id));
  actions.new.addEventListener('click', () => {
    item.review = null;
    fields.confirm.checked = false;
    status(fields.status, 'Review the approved facts, then generate a new draft.');
    refreshCard(item);
    fields.measurements.focus();
  });
  fields.draft.addEventListener('input', () => {
    fields.confirm.checked = false;
    refreshCard(item);
  });
  fields.confirm.addEventListener('change', () => refreshCard(item));
  actions.check.addEventListener('click', () => runAction(item, 'review', { draft: fields.draft.value }));
  actions.apply.addEventListener('click', () => runAction(item, 'apply', { confirm: fields.confirm.checked }));
  actions.flag.addEventListener('click', () => runAction(item, 'flag', { reason: fields.reason.value }));
  find('cards').append(fragment);
  selected.set(product.id, item);
  refreshCard(item);
}

function removeProduct(id) {
  const item = selected.get(id);
  if (!item || item.busy) return;
  selected.delete(id);
  item.element.remove();
  updateControls();
}

function refreshCard(item) {
  const { fields, actions, review, busy } = item;
  fields.review.hidden = !review;
  fields.measurements.readOnly = Boolean(review) || busy;
  fields.phrases.readOnly = Boolean(review) || busy;
  actions.remove.disabled = busy;
  if (review) {
    const dirty = fields.draft.value !== review.draft;
    const canWrite = !review.receipt && !dirty && !review.flagged && review.findings.length === 0;
    fields.draft.readOnly = busy || Boolean(review.receipt);
    fields.confirm.disabled = busy || !canWrite;
    actions.check.disabled = busy || !dirty || Boolean(review.receipt);
    actions.new.disabled = busy;
    actions.apply.disabled = busy || !canWrite || !fields.confirm.checked;
    actions.flag.disabled = busy || dirty || review.flagged;
    fields.reason.disabled = actions.flag.disabled;
    const issue = dirty || review.flagged || review.findings.length > 0;
    fields.outcome.toggleAttribute('data-issue', issue);
    if (dirty) fields.outcome.textContent = 'Check the edited draft before applying it.';
    else if (review.receipt && review.flagged) fields.outcome.textContent = 'Description saved and draft flagged for review.';
    else if (review.flagged) fields.outcome.textContent = 'Draft flagged for review.';
    else if (review.receipt) fields.outcome.textContent = 'Description saved and verified.';
    else if (review.findings.length) fields.outcome.textContent = 'Resolve these findings before applying.';
    else fields.outcome.textContent = 'Configured facts are present. Review the full text before applying.';
  }
  updateControls();
}

function showReview(item, review) {
  const { fields } = item;
  item.review = review;
  fields.confirm.checked = false;
  fields.current.textContent = review.current || 'No existing description.';
  fields.draft.value = review.draft;
  const labels = {
    missing: 'Missing measurement',
    extra: 'Unapproved measurement',
    phrase: 'Missing required phrase',
    empty: 'Draft is empty',
  };
  fields.findings.replaceChildren(...review.findings.map(({ kind, value }) => {
    const line = document.createElement('li');
    line.textContent = value ? `${labels[kind]}: ${value}` : labels[kind];
    return line;
  }));
}

async function runAction(item, action, data) {
  item.busy = true;
  status(item.fields.status, '');
  refreshCard(item);
  try {
    const { id, revision } = item.review;
    showReview(item, await api(`/api/drafts/${id}/${action}`, { revision, ...data }));
  } catch (error) {
    status(item.fields.status, error.message, true);
  } finally {
    item.busy = false;
    refreshCard(item);
  }
}

async function generateBatch() {
  if (batching || !model.value) return;
  const pending = [...selected.values()].filter((item) => !item.review);
  const modelId = model.value;
  batching = true;
  for (const item of pending) {
    item.busy = true;
    status(item.fields.status, 'Queued…');
    refreshCard(item);
  }

  let completed = 0;
  for (const item of pending) {
    const { product, fields } = item;
    status(fields.status, 'Generating…');
    try {
      showReview(item, await api('/api/drafts', {
        productId: product.id,
        model: modelId,
        measurements: fields.measurements.value,
        phrases: fields.phrases.value,
      }));
      status(fields.status, '');
      completed += 1;
    } catch (error) {
      status(fields.status, error.message, true);
    } finally {
      item.busy = false;
      refreshCard(item);
    }
  }
  batching = false;
  status(operation, `${completed} of ${pending.length} drafts ready for review.`, completed < pending.length);
  updateControls();
}

find('search').addEventListener('submit', (event) => {
  event.preventDefault();
  loadProducts(find('search-title').value.trim());
});
nextPage.addEventListener('click', () => loadProducts(searchTitle, cursor));
model.addEventListener('change', updateControls);
generate.addEventListener('click', generateBatch);
loadProducts('');
loadModels();
