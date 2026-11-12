'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const keys = ['travel', 'lodging', 'food', 'other'];
const labels = ['Travel', 'Lodging', 'Food', 'Other'];

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fresh = () => ({
  name: '',
  designation: '',
  project: '',
  purpose: '',
  date: today(),
  expenses: [],
  bills: []
});

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

const icon = n => `<svg aria-hidden="true"><use href="#${n}"/></svg>`;
const cents = v => Math.round(Number(v || 0) * 100);
const rowCents = r => keys.reduce((sum, key) => sum + cents(r[key]), 0);
const money = c => '₹' + (c / 100).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const fmtNum = c => (c / 100).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const dateLabel = s => /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('-') : s;

let state = { draft: fresh(), history: [] };
let tab = 'details';
let editIndex = -1;
let confirmAction = null;
let latestId = null;
let saveTimer;
let activePreviewUrl = null;

// ---------------- IndexedDB File Store ----------------
const DB_NAME = 'fervidClaimsDB';
const DB_STORE = 'files';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) {
        req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbKeys() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function cleanupUnusedReceipts() {
  try {
    const keep = new Set();
    for (const b of (state.draft.bills || [])) keep.add(b.id);
    if (state.draft.expenseEditor) {
      for (const b of (state.draft.expenseEditor.bills || [])) keep.add(b.id);
    }
    for (const h of (state.history || [])) {
      keep.add('pdf_' + h.id);
      for (const b of (h.draft?.bills || [])) keep.add(b.id);
    }
    const all = await idbKeys();
    for (const k of all) {
      if (!keep.has(k)) await idbDelete(k);
    }
  } catch (e) {}
}

// ---------------- Load Initial State ----------------
try {
  state = JSON.parse(localStorage.getItem('fervidClaims') || 'null') || state;
} catch (e) {}

if (!state.draft) state.draft = fresh();
if (!Array.isArray(state.history)) state.history = [];

// ---------------- iOS Install Banner & Service Worker ----------------
(function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isIOS && !isStandalone && !localStorage.getItem('fervidInstallDismissed')) {
    const banner = $('#iosInstallBanner');
    if (banner) banner.hidden = false;
  }
  const dismissBtn = $('#dismissInstallBanner');
  if (dismissBtn) {
    dismissBtn.onclick = () => {
      $('#iosInstallBanner').hidden = true;
      localStorage.setItem('fervidInstallDismissed', '1');
    };
  }
})();

function total() {
  return state.draft.expenses.reduce((sum, row) => sum + rowCents(row), 0);
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    $('#toast').classList.remove('show');
  }, 3200);
}

function busy(on, text) {
  $('#busy').classList.toggle('hidden', !on);
  if (text) $('#busyText').textContent = text;
}

function persist() {
  captureExpenseEditor();
  normalizeBillLinks();
  clearTimeout(saveTimer);
  let ok;
  try {
    localStorage.setItem('fervidClaims', JSON.stringify(state));
    ok = true;
  } catch (e) {
    ok = false;
  }
  $('#savedBadge').textContent = ok ? '✓ Draft saved' : 'Draft not saved';
  $('#savedBadge').style.color = ok ? '' : '#bd403e';
  return ok;
}

function scheduleSave() {
  $('#savedBadge').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}

function setDetails() {
  for (const key of ['name', 'designation', 'project', 'purpose', 'date']) {
    $('#' + key).value = state.draft[key] || '';
  }
}

function switchTab(nextTab) {
  tab = nextTab;
  $('.app').classList.toggle('flow', tab !== 'details');
  $$('.screen').forEach(screen => {
    screen.classList.toggle('active', screen.id === tab);
  });
  $$('[data-tab]').forEach(button => {
    button.classList.toggle('selected', button.dataset.tab === tab);
  });
  const titles = {
    details: 'Employee details',
    expenses: 'Expense entries',
    receipts: 'Bills & receipts',
    review: 'Review your claim',
    history: 'Claim history'
  };
  $('#screenTitle').textContent = titles[tab];
  $('#stepLabel').textContent =
    tab === 'details' && state.draft.editClaimId
      ? 'EDITING SAVED CLAIM'
      : tab === 'history'
        ? 'SAVED ON THIS PHONE'
        : `STEP 0${['details', 'expenses', 'receipts', 'review'].indexOf(tab) + 1} / 04`;
  render();
  window.scrollTo(0, 0);
}

function ask(title, text, action) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  confirmAction = action;
  $('#confirmDialog').showModal();
}

$('#confirmCancel').onclick = () => $('#confirmDialog').close();
$('#confirmYes').onclick = () => {
  $('#confirmDialog').close();
  if (confirmAction) confirmAction();
};

function empty(symbol, title, body) {
  return `<div class="empty">${icon(symbol)}<h3>${title}</h3><p>${body}</p></div>`;
}

function render() {
  normalizeBillLinks();
  const count = state.draft.expenses.length;
  const totalCents = total();
  const bills = state.draft.bills;

  $('#heroTotal').textContent = money(totalCents);
  $('#expenseTotal').textContent = money(totalCents);
  $('#entryCount').textContent = String(count);
  $('#addExpense').disabled = false;
  $('#reviewTotal').textContent = money(totalCents);
  $('#reviewCount').textContent =
    `${count} expense ${count === 1 ? 'entry' : 'entries'} · ` +
    `${bills.length} receipt ${bills.length === 1 ? 'file' : 'files'}`;

  $('#expenseList').innerHTML = count
    ? state.draft.expenses.map((row, index) => `
      <article class="card expense-card">
        <div class="item-top">
          <span class="soft-icon">${icon('wallet')}</span>
          <div class="content">
            <h3>${esc(row.description)}</h3>
            <div class="meta">
              ${esc(dateLabel(row.date))}
              ${row.travel_mode ? ' · ' + esc(row.travel_mode) : ''}
            </div>
          </div>
          <strong class="amount">${money(rowCents(row))}</strong>
        </div>
        <div class="chips">
          ${keys.map((key, i) => cents(row[key])
            ? `<span>${labels[i]} ${money(cents(row[key]))}</span>`
            : '').join('')}
        </div>
        <div class="item-actions">
          <button type="button" class="mini" data-expense-move="${index},-1" aria-label="Move expense up" ${index === 0 ? 'disabled' : ''}>↑ Up</button>
          <button type="button" class="mini" data-expense-move="${index},1" aria-label="Move expense down" ${index === count - 1 ? 'disabled' : ''}>↓ Down</button>
          <button class="mini" data-edit="${index}">${icon('edit')} Edit</button>
          <button class="mini" data-duplicate="${index}">${icon('plus')} Copy</button>
          <button class="mini danger" aria-label="Remove expense" data-remove="${index}">${icon('trash')}</button>
        </div>
      </article>
    `).join('')
    : empty('wallet', 'No expenses yet', 'Add your first expense to start building your claim.');

  renderBillsTab();

  $('#reviewDetails').innerHTML = ['name', 'designation', 'project', 'purpose', 'date'].map(key => `
    <div class="detail-row">
      <dt>${key.charAt(0).toUpperCase() + key.slice(1)}</dt>
      <dd>${esc(key === 'date' ? dateLabel(state.draft[key]) : state.draft[key]) || '—'}</dd>
    </div>
  `).join('');

  $('#categoryBars').innerHTML = keys.map((key, index) => {
    const categoryCents = state.draft.expenses.reduce((sum, row) => sum + cents(row[key]), 0);
    const colors = ['#08796f', '#429c87', '#8db69f', '#c0cda4'];
    return `
      <div class="bar-row">
        <span>${labels[index]}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width:${totalCents ? categoryCents / totalCents * 100 : 0}%;background:${colors[index]}"></div>
        </div>
        <strong>${money(categoryCents)}</strong>
      </div>
    `;
  }).join('');

  const missing = ['name', 'designation', 'project', 'purpose', 'date']
    .filter(key => !String(state.draft[key] || '').trim());

  const checks = [
    [!missing.length, missing.length ? 'Complete: ' + missing.join(', ') : 'Employee details complete'],
    [count > 0, count ? 'Expense entries added' : 'Add at least one expense']
  ];

  $('#validation').innerHTML = checks.map(([ok, message]) => `
    <div class="check-row ${ok ? '' : 'error'}">${icon(ok ? 'check' : 'info')}${esc(message)}</div>
  `).join('') + `
    <div class="check-row ${bills.length ? '' : 'warn'}">
      ${icon(bills.length ? 'check' : 'info')}
      ${bills.length ? 'Receipts attached' : 'No receipts attached. You can still export.'}
    </div>
  `;

  $('#generateBtn').disabled = !!missing.length || !count;

  $('#historyList').innerHTML = state.history.length
    ? state.history.slice().reverse().map(claim => `
      <article class="card">
        <div class="item-top">
          <span class="soft-icon">${icon('check')}</span>
          <div class="content">
            <h3>${esc(claim.draft.purpose)}</h3>
            <div class="meta">
              ${esc(claim.draft.name)} · ${esc(dateLabel(claim.draft.date))}
              <br>Exported · ${claim.pageCount || ''} pages
            </div>
          </div>
          <strong class="amount">${money(claim.totalCents)}</strong>
        </div>
        <div class="item-actions" style="margin-top:14px">
          <button class="mini" data-preview="${esc(claim.id)}">${icon('file')} Preview</button>
          <button class="mini" data-claim-edit="${esc(claim.id)}">${icon('edit')} Edit</button>
          <button class="mini" data-share="${esc(claim.id)}">${icon('share')} Share</button>
          <button class="mini" data-save="${esc(claim.id)}">${icon('download')} Save</button>
          <button class="mini" data-reuse="${esc(claim.id)}">${icon('edit')} Reuse</button>
          <button class="mini danger" aria-label="Delete exported claim" data-history-remove="${esc(claim.id)}">${icon('trash')}</button>
        </div>
      </article>
    `).join('')
    : empty('clock', 'No exported claims yet', 'Your generated reimbursement PDFs will appear here.');
}

function showExpense(index = -1, resume = false) {
  normalizeBillLinks();
  editIndex = index;
  const form = $('#expenseForm');
  form.reset();

  let row;
  if (resume && state.draft.expenseEditor) {
    row = state.draft.expenseEditor.values;
  } else {
    row = index >= 0 ? state.draft.expenses[index] : { date: state.draft.date || today() };
    state.draft.expenseEditor = {
      id: row.id || expenseUid(),
      session: expenseUid(),
      values: { ...row },
      bills: row.id ? state.draft.bills.filter(bill => bill.expenseId === row.id).map(bill => ({ ...bill })) : []
    };
  }

  ['description', 'date', ...keys].forEach(key => {
    form.elements[key].value = row[key] || '';
  });

  const mode = form.elements.travel_mode;
  const known = Array.from(mode.options).some(option => option.value === (row.travel_mode || ''));
  mode.value = known ? (row.travel_mode || '') : 'Custom';
  form.elements.custom_mode.value = row.custom_mode || (known ? '' : (row.travel_mode || ''));

  $('#customModeLabel').hidden = mode.value !== 'Custom';
  $('#dialogTitle').textContent = index < 0 ? 'Add expense' : 'Edit expense';
  live();
  document.body.classList.add('expense-open');
  $('#expenseDialog').showModal();
  $('#expenseDialog').scrollTop = 0;
  renderExpenseBills();
  persist();
}

function live() {
  const totalCents = keys.reduce((sum, key) => sum + cents($('#expenseForm').elements[key].value), 0);
  $('#liveTotal').textContent = money(totalCents);
}

$('#expenseForm').elements.travel_mode.onchange = () => {
  $('#customModeLabel').hidden = $('#expenseForm').elements.travel_mode.value !== 'Custom';
};
$('#expenseForm').oninput = () => { live(); persist(); };

$('#expenseForm').onsubmit = event => {
  event.preventDefault();
  if (receiptBusy) return toast('Please finish attaching the bill first.');

  const form = event.target;
  const row = { id: state.draft.expenseEditor.id };

  ['description', 'date'].forEach(key => {
    row[key] = form.elements[key].value.trim();
  });

  row.travel_mode = form.elements.travel_mode.value === 'Custom'
    ? form.elements.custom_mode.value.trim()
    : form.elements.travel_mode.value;

  if (form.elements.travel_mode.value === 'Custom' && !row.travel_mode) {
    return toast('Enter a custom travel mode.');
  }

  for (const key of keys) {
    const value = form.elements[key].value.trim();
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(value || '0') || Number(value) > 9999999) {
      return toast('Use a non-negative amount with up to 2 decimal places.');
    }
    row[key] = (cents(value) / 100).toFixed(2);
  }

  if (!row.description) return toast('Enter an expense description.');
  if (rowCents(row) <= 0) return toast('Add an amount greater than zero.');

  if (editIndex < 0) state.draft.expenses.push(row);
  else state.draft.expenses[editIndex] = row;

  const editor = state.draft.expenseEditor;
  state.draft.bills = state.draft.bills.filter(bill => bill.expenseId !== row.id)
    .concat(editor.bills.map(bill => ({ ...bill, expenseId: row.id })));
  delete state.draft.expenseEditor;
  $('#expenseDialog').close();
  persist();
  render();
  toast('Expense saved');
};

$('#closeExpense').onclick = () => {
  if (receiptBusy) return;
  $('#expenseDialog').close();
};
$('#addExpense').onclick = () => showExpense();

$('#expenseDialog').addEventListener('close', () => {
  document.body.classList.remove('expense-open');
  delete state.draft.expenseEditor;
  persist();
  cleanupUnusedReceipts();
});

$$('[data-detail]').forEach(input => {
  input.oninput = () => {
    state.draft[input.id] = input.value;
    scheduleSave();
  };
});

$$('[data-tab]').forEach(button => {
  button.onclick = () => { persist(); switchTab(button.dataset.tab); };
});
$$('[data-next]').forEach(button => {
  button.onclick = () => { persist(); switchTab(button.dataset.next); };
});
$('#historyBtn').onclick = () => { persist(); switchTab('history'); };

$('#attachBtn').onclick = () => {
  if (!state.draft.expenses.length) {
    switchTab('expenses');
    showExpense();
  } else {
    toast('Choose Add / edit bills under the matching expense below.');
  }
};

$('#expenseList').onclick = event => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.hasAttribute('data-expense-move')) {
    const [index, direction] = button.dataset.expenseMove.split(',').map(Number);
    const nextIndex = index + direction;
    const expenses = state.draft.expenses;
    if (nextIndex < 0 || nextIndex >= expenses.length) return;
    [expenses[index], expenses[nextIndex]] = [expenses[nextIndex], expenses[index]];
    normalizeBillLinks();
    persist();
    render();
    return;
  }

  if (button.hasAttribute('data-edit')) showExpense(+button.dataset.edit);

  if (button.hasAttribute('data-duplicate')) {
    state.draft.expenses.push({ ...state.draft.expenses[+button.dataset.duplicate], id: expenseUid() });
    persist();
    render();
    toast('Expense copied. Edit its date or amounts as needed.');
  }

  if (button.hasAttribute('data-remove')) {
    ask(
      'Remove this expense?',
      'This expense and its linked bills will be removed from this draft. Saved claims and original files are kept.',
      () => {
        const [removed] = state.draft.expenses.splice(+button.dataset.remove, 1);
        state.draft.bills = state.draft.bills.filter(bill => bill.expenseId !== removed.id);
        persist();
        render();
        cleanupUnusedReceipts();
      }
    );
  }
};

$('#receiptList').onclick = event => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.hasAttribute('data-bill-edit-expense')) showExpense(+button.dataset.billEditExpense);
  if (button.dataset.receiptPreview) previewStoredFile(button.dataset.receiptPreview, 'Receipt preview');

  if (button.hasAttribute('data-move')) {
    const [index, direction] = button.dataset.move.split(',').map(Number);
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= state.draft.bills.length) return;
    if ((state.draft.bills[index].expenseId || '') !== (state.draft.bills[nextIndex].expenseId || '')) return;
    [state.draft.bills[index], state.draft.bills[nextIndex]] = [state.draft.bills[nextIndex], state.draft.bills[index]];
    persist();
    render();
  }

  if (button.hasAttribute('data-bill-remove')) {
    ask(
      'Remove this receipt?',
      'The original file on your phone is kept.',
      () => {
        state.draft.bills.splice(+button.dataset.billRemove, 1);
        persist();
        render();
        cleanupUnusedReceipts();
      }
    );
  }
};

$('#newClaim').onclick = () => {
  ask(
    'Start a new claim?',
    'Your current draft will be cleared. Exported claims in history will remain. Employee name and designation will be kept.',
    () => {
      const old = state.draft;
      state.draft = { ...fresh(), name: old.name, designation: old.designation };
      setDetails();
      persist();
      switchTab('details');
    }
  );
};

// ---------------- Preview, Share, Save ----------------
function closePreviewDialog() {
  $('#previewDialog').close();
  $('#previewBody').innerHTML = '';
  if (activePreviewUrl) {
    URL.revokeObjectURL(activePreviewUrl);
    activePreviewUrl = null;
  }
}
$('#closePreview').onclick = closePreviewDialog;
$('#previewDialog').addEventListener('close', closePreviewDialog);

async function previewStoredFile(fileId, title) {
  const rec = await idbGet(fileId);
  if (!rec || !rec.blob) return toast('File not found on this device.');

  if (activePreviewUrl) URL.revokeObjectURL(activePreviewUrl);
  activePreviewUrl = URL.createObjectURL(rec.blob);
  $('#previewTitle').textContent = title || rec.name || 'Preview';

  const body = $('#previewBody');
  if (rec.type === 'application/pdf') {
    body.innerHTML = `
      <div style="width:100%;display:flex;flex-direction:column;gap:10px;">
        <iframe src="${activePreviewUrl}" title="PDF Preview"></iframe>
        <a href="${activePreviewUrl}" target="_blank" rel="noopener" class="button secondary wide" style="text-decoration:none;justify-content:center;">Open PDF in full screen</a>
      </div>`;
  } else {
    body.innerHTML = `<img src="${activePreviewUrl}" alt="${esc(rec.name || 'Receipt')}">`;
  }
  $('#previewDialog').showModal();
}

function previewPdf(id) {
  previewStoredFile('pdf_' + id, 'Reimbursement PDF');
}

function pdfFileName(claim) {
  const safeName = (claim?.draft?.name || 'Claim').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const d = claim?.draft?.date || today();
  return `Fervid_Claim_${safeName}_${d}.pdf`;
}

async function share(id) {
  const rec = await idbGet('pdf_' + id);
  if (!rec || !rec.blob) return toast('PDF not found.');
  const claim = state.history.find(c => c.id === id);
  const name = pdfFileName(claim);
  const file = new File([rec.blob], name, { type: 'application/pdf' });

  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  // Fallback to download
  triggerDownload(rec.blob, name);
  toast('PDF downloaded.');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function savePdf(id) {
  const rec = await idbGet('pdf_' + id);
  if (!rec || !rec.blob) return toast('PDF not found.');
  const claim = state.history.find(c => c.id === id);
  const name = pdfFileName(claim);

  triggerDownload(rec.blob, name);

  // Match Android app behavior: reset draft for next claim when saving from success dialog
  if (latestId === id) {
    $$('dialog').forEach(dialog => { if (dialog.open) dialog.close(); });
    clearTimeout(saveTimer);
    const old = state.draft;
    state.draft = { ...fresh(), name: old.name, designation: old.designation };
    latestId = null;
    setDetails();
    persist();
    switchTab('details');
    toast('PDF saved. Ready for a new reimbursement.');
  } else {
    toast('PDF saved to downloads.');
  }
}

$('#historyList').onclick = event => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.dataset.preview) previewPdf(button.dataset.preview);

  if (button.dataset.claimEdit) {
    ask(
      'Edit saved claim?',
      'This loads the saved claim into your form. Generating the PDF again updates this history entry. Copies already downloaded remain unchanged.',
      () => {
        const claim = state.history.find(item => item.id === button.dataset.claimEdit);
        state.draft = JSON.parse(JSON.stringify(claim.draft));
        state.draft.editClaimId = claim.id;
        setDetails();
        persist();
        switchTab('details');
        toast('Editing saved claim');
      }
    );
  }

  if (button.dataset.share) share(button.dataset.share);
  if (button.dataset.save) savePdf(button.dataset.save);

  if (button.dataset.reuse) {
    ask(
      'Reuse this claim?',
      'This replaces your current draft with the saved claim. Change its dates and expenses before exporting.',
      () => {
        const claim = state.history.find(item => item.id === button.dataset.reuse);
        state.draft = JSON.parse(JSON.stringify(claim.draft));
        delete state.draft.editClaimId;
        state.draft.date = today();
        setDetails();
        persist();
        switchTab('details');
      }
    );
  }

  if (button.dataset.historyRemove) {
    ask(
      'Delete exported claim?',
      'This removes the app’s saved PDF and history entry. Copies you already saved or shared remain.',
      async () => {
        const id = button.dataset.historyRemove;
        state.history = state.history.filter(item => item.id !== id);
        if (state.draft.editClaimId === id) delete state.draft.editClaimId;
        await idbDelete('pdf_' + id);
        persist();
        render();
        cleanupUnusedReceipts();
      }
    );
  }
};

// ---------------- Client-Side PDF Generation ----------------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function fitText(ctx, text, maxWidth) {
  let s = String(text || '');
  if (ctx.measureText(s).width <= maxWidth) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s + '…';
}

function canvasToJpegBytes(canvas, quality = 0.9) {
  return new Promise(resolve => {
    canvas.toBlob(async blob => {
      const buf = await blob.arrayBuffer();
      resolve(new Uint8Array(buf));
    }, 'image/jpeg', quality);
  });
}

// Pure-JS PDF 1.4 builder from JPEG pages (works 100% offline with zero dependencies)
function buildPdfFromJpegs(jpegPages) {
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [0];

  const push = data => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    offset += bytes.length;
  };

  push('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  const pageCount = jpegPages.length;
  // Objects: 1=Catalog, 2=Pages, then per page: (3 + i*3)=Page, (4 + i*3)=Content, (5 + i*3)=Image
  const pageIds = [];
  for (let i = 0; i < pageCount; i++) pageIds.push(3 + i * 3);

  offsets[1] = offset;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[2] = offset;
  push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>\nendobj\n`);

  const ptW = 595.28;
  const ptH = 841.89;

  for (let i = 0; i < pageCount; i++) {
    const pg = jpegPages[i];
    const pageObj = 3 + i * 3;
    const contentObj = 4 + i * 3;
    const imgObj = 5 + i * 3;

    const stream = `q\n${ptW} 0 0 ${ptH} 0 0 cm\n/Im0 Do\nQ\n`;

    offsets[pageObj] = offset;
    push(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW} ${ptH}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);

    offsets[contentObj] = offset;
    push(`${contentObj} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);

    offsets[imgObj] = offset;
    push(`${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`);
    push(pg.bytes);
    push('\nendstream\nendobj\n');
  }

  const xrefPos = offset;
  const totalObjs = 2 + pageCount * 3 + 1;
  push(`xref\n0 ${totalObjs}\n`);
  push('0000000000 65535 f \n');
  for (let i = 1; i < totalObjs; i++) {
    push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  }
  push(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  return new Blob(chunks, { type: 'application/pdf' });
}

async function ensurePdfLib() {
  if (window.PDFLib) return window.PDFLib;
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.PDFLib || null;
  } catch (e) {
    return null;
  }
}

async function renderCompanyFormPages(draft) {
  const formImg = await loadImage('./company_form.png');
  const W = formImg.naturalWidth || 1698;
  const H = formImg.naturalHeight || 2400;

  const rowsPerPage = 14;
  const expenses = draft.expenses || [];
  const formPageCount = Math.max(1, Math.ceil(expenses.length / rowsPerPage));

  const grandTotals = { travel: 0, lodging: 0, food: 0, other: 0, total: 0 };
  for (const r of expenses) {
    for (const k of keys) grandTotals[k] += cents(r[k]);
    grandTotals.total += rowCents(r);
  }

  const canvases = [];
  for (let p = 0; p < formPageCount; p++) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(formImg, 0, 0, W, H);

    ctx.fillStyle = '#141918';
    ctx.textBaseline = 'alphabetic';

    // Header fields
    ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, draft.purpose, 540), 214, 430);
    ctx.fillText(fitText(ctx, draft.name, 540), 214, 470);
    ctx.fillText(dateLabel(draft.date), 214, 510);

    ctx.fillText(fitText(ctx, draft.designation, 300), 914, 430);
    ctx.fillText(fitText(ctx, draft.project, 300), 914, 470);

    // Table rows
    const slice = expenses.slice(p * rowsPerPage, (p + 1) * rowsPerPage);
    const yStart = 637;
    const rowH = 25.78;
    ctx.font = '500 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    slice.forEach((row, idx) => {
      const y = yStart + idx * rowH + 19;
      ctx.textAlign = 'center';
      ctx.fillText(dateLabel(row.date), 130, y);

      ctx.textAlign = 'left';
      ctx.fillText(fitText(ctx, row.description, 526), 217, y);

      ctx.textAlign = 'center';
      ctx.fillText(fitText(ctx, row.travel_mode || '—', 140), 831, y);

      ctx.textAlign = 'right';
      const vals = [cents(row.travel), cents(row.lodging), cents(row.food), cents(row.other), rowCents(row)];
      const xs = [1054, 1204, 1341, 1476, 1635];
      vals.forEach((v, i) => {
        if (v > 0 || i === 4) ctx.fillText(fmtNum(v), xs[i], y);
      });
    });

    // Totals row (show grand totals on last page, or page totals if intermediate)
    const isLast = p === formPageCount - 1;
    const tVals = isLast
      ? [grandTotals.travel, grandTotals.lodging, grandTotals.food, grandTotals.other, grandTotals.total]
      : [
          slice.reduce((s, r) => s + cents(r.travel), 0),
          slice.reduce((s, r) => s + cents(r.lodging), 0),
          slice.reduce((s, r) => s + cents(r.food), 0),
          slice.reduce((s, r) => s + cents(r.other), 0),
          slice.reduce((s, r) => s + rowCents(r), 0)
        ];

    ctx.font = '700 19px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'right';
    [1054, 1204, 1341, 1476, 1635].forEach((x, i) => {
      ctx.fillText(fmtNum(tVals[i]), x, 1022);
    });

    // Submitted By
    ctx.font = '600 19px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, draft.name, 260), 1495, 1320);

    canvases.push(canvas);
  }
  return canvases;
}

async function renderReceiptImagePage(blob, labelText) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const W = 1240;
    const H = 1754;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Header strip
    ctx.fillStyle = '#f2f6f5';
    ctx.fillRect(0, 0, W, 86);
    ctx.fillStyle = '#08796f';
    ctx.fillRect(0, 84, W, 3);
    ctx.fillStyle = '#182422';
    ctx.font = '600 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, labelText, W - 80), 40, 52);

    // Fit image
    const pad = 48;
    const maxW = W - pad * 2;
    const maxH = H - 120 - pad;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    const dx = (W - dw) / 2;
    const dy = 110 + (maxH - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);

    return { width: W, height: H, bytes: await canvasToJpegBytes(canvas, 0.88) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function generate() {
  if (!persist()) {
    return toast('Could not save the draft. Please free some phone storage.');
  }

  busy(true, 'Creating your PDF…');
  try {
    const draft = JSON.parse(JSON.stringify(state.draft));
    const formCanvases = await renderCompanyFormPages(draft);
    const jpegPages = [];

    for (const c of formCanvases) {
      jpegPages.push({ width: c.width, height: c.height, bytes: await canvasToJpegBytes(c, 0.9) });
    }

    const expMap = new Map(draft.expenses.map((e, i) => [e.id, `${i + 1}. ${e.description}`]));
    const pdfReceipts = [];

    for (const bill of draft.bills) {
      const rec = await idbGet(bill.id);
      if (!rec || !rec.blob) continue;
      const expLabel = expMap.get(bill.expenseId) || 'Unassigned receipt';
      if (rec.type === 'application/pdf') {
        pdfReceipts.push({ rec, label: `${expLabel} · ${bill.name}` });
      } else {
        const page = await renderReceiptImagePage(rec.blob, `${expLabel} · ${bill.name}`);
        jpegPages.push(page);
      }
    }

    let finalBlob = buildPdfFromJpegs(jpegPages);
    let totalPages = jpegPages.length;

    // If PDF receipts were attached, merge them using pdf-lib when available
    if (pdfReceipts.length) {
      const PDFLib = await ensurePdfLib();
      if (PDFLib) {
        const baseDoc = await PDFLib.PDFDocument.load(await finalBlob.arrayBuffer());
        for (const item of pdfReceipts) {
          try {
            const srcDoc = await PDFLib.PDFDocument.load(await item.rec.blob.arrayBuffer());
            const copied = await baseDoc.copyPages(srcDoc, srcDoc.getPageIndices());
            copied.forEach(p => baseDoc.addPage(p));
          } catch (e) {}
        }
        totalPages = baseDoc.getPageCount();
        finalBlob = new Blob([await baseDoc.save()], { type: 'application/pdf' });
      } else {
        toast('Offline mode: attached PDF receipts require internet on first use to merge.');
      }
    }

    const claimId = draft.editClaimId || ('c_' + Date.now().toString(36));
    await idbPut({
      id: 'pdf_' + claimId,
      name: `claim_${claimId}.pdf`,
      type: 'application/pdf',
      size: finalBlob.size,
      blob: finalBlob
    });

    const entry = {
      id: claimId,
      totalCents: total(),
      pageCount: totalPages,
      createdAt: new Date().toISOString(),
      draft: JSON.parse(JSON.stringify(draft))
    };
    delete entry.draft.editClaimId;

    const existingIdx = state.history.findIndex(h => h.id === claimId);
    if (existingIdx >= 0) state.history[existingIdx] = entry;
    else state.history.push(entry);

    latestId = claimId;
    state.draft.editClaimId = claimId;
    persist();
    render();
    busy(false);
    $('#successDialog').showModal();
  } catch (err) {
    console.error(err);
    busy(false);
    toast('Failed to generate PDF: ' + (err.message || 'Unknown error'));
  }
}

$('#generateBtn').onclick = () => {
  if (!state.draft.bills.length) {
    ask(
      'Export without receipts?',
      'Your office may require receipts for reimbursement. You can attach them now or continue without them.',
      generate
    );
  } else {
    generate();
  }
};

$('#previewLatest').onclick = () => previewPdf(latestId);
$('#shareLatest').onclick = () => share(latestId);
$('#saveLatest').onclick = () => savePdf(latestId);
$('#closeSuccess').onclick = () => $('#successDialog').close();

window.addEventListener('pagehide', persist);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) persist();
});

function expenseUid() {
  return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
}

function normalizeBillLinks() {
  const seen = new Set();
  for (const row of state.draft.expenses) {
    if (!row.id || seen.has(row.id)) row.id = expenseUid();
    seen.add(row.id);
  }
  const rank = new Map(state.draft.expenses.map((row, i) => [row.id, i]));
  state.draft.bills = state.draft.bills.map((bill, i) => ({ bill, i }))
    .sort((a, b) => (rank.get(a.bill.expenseId) ?? Infinity) - (rank.get(b.bill.expenseId) ?? Infinity) || a.i - b.i)
    .map(item => item.bill);
}

let receiptBusy = false;

function setReceiptBusy(on, text = '') {
  receiptBusy = on;
  $('#expenseForm').querySelectorAll('button,input,select,textarea')
    .forEach(input => { input.disabled = on; });
  $('#expenseBillStatus').textContent = text;
}

function captureExpenseEditor() {
  const editor = state.draft.expenseEditor;
  if (!editor || !$('#expenseDialog').open) return;
  editor.values = {};
  for (const key of ['description', 'date', ...keys, 'travel_mode', 'custom_mode']) {
    editor.values[key] = $('#expenseForm').elements[key].value;
  }
}

function billCard(bill, index, editing = false) {
  const list = editing ? state.draft.expenseEditor.bills : state.draft.bills;
  const group = bill.expenseId || '';
  const prefix = editing ? 'data-editor-' : 'data-';
  return `<article class="card receipt-card">
    <h3 class="receipt-file">${esc(bill.name)}</h3>
    <p class="meta">${bill.type === 'application/pdf' ? 'PDF' : 'Image'} · ${(Number(bill.size) / 1024 / 1024).toFixed(2)} MB</p>
    <div class="item-actions">
      <button type="button" class="mini" ${prefix}receipt-preview="${esc(bill.id)}">Preview</button>
      <button type="button" class="mini" ${prefix}move="${index},-1" ${index === 0 || (list[index - 1].expenseId || '') !== group ? 'disabled' : ''}>↑</button>
      <button type="button" class="mini" ${prefix}move="${index},1" ${index === list.length - 1 || (list[index + 1].expenseId || '') !== group ? 'disabled' : ''}>↓</button>
      <button type="button" class="mini danger" ${prefix}bill-remove="${index}">Remove</button>
    </div>
    ${editing ? '' : `<label>Linked expense
      <select data-bill-link="${index}"><option value="">Unassigned</option>
      ${state.draft.expenses.map((row, i) => `<option value="${esc(row.id)}" ${row.id === bill.expenseId ? 'selected' : ''}>${i + 1}. ${esc(row.description)}</option>`).join('')}
      </select></label>`}
  </article>`;
}

function renderExpenseBills() {
  const editor = state.draft.expenseEditor;
  $('#expenseBillList').innerHTML = !editor || !editor.bills.length
    ? '<p class="caption">No bills attached. Adding a bill is optional.</p>'
    : editor.bills.map((bill, i) => billCard(bill, i, true)).join('');
}

function renderBillsTab() {
  const bills = state.draft.bills;
  let html = '';
  state.draft.expenses.forEach((row, i) => {
    const linked = bills.map((bill, index) => ({ bill, index }))
      .filter(item => item.bill.expenseId === row.id);
    html += `<section class="bill-group"><h3>${i + 1}. ${esc(row.description)}</h3>
      <p class="meta">${esc(dateLabel(row.date))} · ${money(rowCents(row))}</p>
      <button type="button" class="mini" data-bill-edit-expense="${i}">Add / edit bills</button>
      ${linked.length ? linked.map(item => billCard(item.bill, item.index)).join('') : '<p class="caption">No bill attached to this expense.</p>'}</section>`;
  });
  const ids = new Set(state.draft.expenses.map(row => row.id));
  const old = bills.map((bill, index) => ({ bill, index })).filter(item => !ids.has(item.bill.expenseId));
  if (old.length) {
    html += `<section class="bill-group"><h3>Unassigned bills</h3>
      <p class="caption">Choose the matching expense below each bill.</p>
      ${old.map(item => billCard(item.bill, item.index)).join('')}</section>`;
  }
  $('#receiptList').innerHTML = html || empty('receipt', 'No expenses yet', 'Add an expense, then take a photo or upload its bill.');
}

// ---------------- iOS Camera & File Picker ----------------
async function compressImageIfNeeded(file) {
  if (file.type === 'application/pdf') return { blob: file, type: 'application/pdf', size: file.size };
  try {
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    URL.revokeObjectURL(url);
    const maxDim = 2000;
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > maxDim || h > maxDim) {
      const s = maxDim / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
    return { blob, type: 'image/jpeg', size: blob.size };
  } catch (e) {
    return { blob: file, type: file.type || 'image/jpeg', size: file.size };
  }
}

async function handleSelectedFiles(fileList) {
  const editor = state.draft.expenseEditor;
  if (!editor || !fileList || !fileList.length) return;
  setReceiptBusy(true, 'Processing attachment…');
  try {
    let added = 0;
    for (const file of Array.from(fileList)) {
      if (file.size > 25 * 1024 * 1024) {
        toast(`${file.name} exceeds 25 MB limit.`);
        continue;
      }
      const processed = await compressImageIfNeeded(file);
      const billId = 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
      await idbPut({
        id: billId,
        name: file.name || `Receipt_${Date.now()}.jpg`,
        type: processed.type,
        size: processed.size,
        blob: processed.blob
      });
      editor.bills.push({
        id: billId,
        name: file.name || `Receipt_${Date.now()}.jpg`,
        type: processed.type,
        size: processed.size,
        expenseId: editor.id
      });
      added++;
    }
    if (added) {
      persist();
      render();
      renderExpenseBills();
      toast(added === 1 ? 'Bill attached' : `${added} bills attached`);
    }
  } catch (e) {
    toast('Could not attach file.');
  } finally {
    setReceiptBusy(false);
  }
}

$('#cameraInput').onchange = async e => {
  await handleSelectedFiles(e.target.files);
  e.target.value = '';
};

$('#fileInput').onchange = async e => {
  await handleSelectedFiles(e.target.files);
  e.target.value = '';
};

function requestExpenseBill(camera) {
  if (receiptBusy) return;
  if (!state.draft.expenseEditor) return;
  if (!persist()) return toast('Could not save this entry.');
  if (camera) $('#cameraInput').click();
  else $('#fileInput').click();
}

$('#takeExpensePhoto').onclick = () => requestExpenseBill(true);
$('#uploadExpenseBill').onclick = () => requestExpenseBill(false);

$('#expenseBillList').onclick = event => {
  if (receiptBusy) return;
  const button = event.target.closest('button');
  if (!button) return;
  const bills = state.draft.expenseEditor.bills;
  if (button.dataset.editorReceiptPreview) {
    persist();
    previewStoredFile(button.dataset.editorReceiptPreview, 'Receipt preview');
  }
  if (button.hasAttribute('data-editor-bill-remove')) {
    bills.splice(+button.dataset.editorBillRemove, 1);
    persist();
    renderExpenseBills();
  }
  if (button.hasAttribute('data-editor-move')) {
    const [i, delta] = button.dataset.editorMove.split(',').map(Number);
    if (i + delta < 0 || i + delta >= bills.length) return;
    [bills[i], bills[i + delta]] = [bills[i + delta], bills[i]];
    persist();
    renderExpenseBills();
  }
};

$('#receiptList').onchange = event => {
  const select = event.target.closest('[data-bill-link]');
  if (!select) return;
  state.draft.bills[+select.dataset.billLink].expenseId = select.value;
  persist();
  render();
};

$('#expenseDialog').addEventListener('cancel', event => {
  if (receiptBusy) event.preventDefault();
});

normalizeBillLinks();
if (!state.draft.editClaimId) state.draft.date = today();
setDetails();
render();
if (state.draft.expenseEditor) {
  const index = state.draft.expenses.findIndex(row => row.id === state.draft.expenseEditor.id);
  showExpense(index, true);
}
persist();
