(() => {
  const context = <%- JSON.stringify(reportData.payrollContext).replace(/</g, '\\u003c') %>;
  const csrf = <%- JSON.stringify(csrfToken).replace(/</g, '\\u003c') %>;
  const messages = <%- JSON.stringify(Object.fromEntries(['payroll_close','payroll_history','payroll_history_help','payroll_preview','salary_view_finalized','loading','no_entries','generic_error','salary_review_timeout','salary_period_not_ended','payroll_queued_help'].map(key => [key,t(key)]))).replace(/</g, '\\u003c') %>;
  const types = <%- JSON.stringify({ PAYROLL_ACCRUAL:t('salary_accrual_history'),PAYROLL_GUARANTEE:t('guarantee_adjustment'),PAYROLL_DEDUCTION:t('salary_absence_deduction') }).replace(/</g, '\\u003c') %>;
  const dialog = document.querySelector('[data-payroll-dialog]');
  if (!dialog) return;
  const form = dialog.querySelector('[data-payroll-form]');
  const finalize = dialog.querySelector('[data-payroll-finalize]');
  const preview = dialog.querySelector('[data-payroll-preview]');
  const history = dialog.querySelector('[data-payroll-history]');
  const notice = dialog.querySelector('[data-payroll-notice]');
  const more = dialog.querySelector('[data-payroll-more]');
  const title = dialog.querySelector('[data-payroll-title]');
  let hash = null, nextCursor = null, busy = false, trigger, mode, revision = 0, controller, dirty = false, uncertain = false;
  const invalidate = () => { hash = null; finalize.disabled = true; preview.hidden = true; };
  const money = value => window.erpDisplay.formatNumber(value, { decimals: 2, fallback: '0' });
  const date = value => window.erpDisplay.formatDate(value);
  const render = (snapshot, saved) => {
    invalidate();
    dialog.querySelector('[data-payroll-preview-heading]').textContent = messages[saved ? 'salary_view_finalized' : 'payroll_preview'];
    dialog.querySelector('[data-payroll-preview-period]').textContent = `${date(snapshot.period_from)} – ${date(snapshot.period_to)}`;
    dialog.querySelectorAll('[data-payroll-total]').forEach(node => { node.textContent = money(snapshot[node.dataset.payrollTotal] || 0); });
    dialog.querySelectorAll('[data-payroll-guarantee]').forEach(node => { node.hidden = !snapshot.guarantee_periods?.length; });
    const body = dialog.querySelector('[data-payroll-lines]'); body.replaceChildren();
    (snapshot.rows || []).forEach(row => {
      const line = document.createElement('tr'); line.className = 'border-t border-slate-100';
      [date(row.entry_date), types[row.voucher_type] || row.voucher_type, money(row.debit), money(row.credit)].forEach(value => {
        const cell = document.createElement('td'); cell.className = 'whitespace-nowrap px-3 py-2'; cell.textContent = value; line.appendChild(cell);
      }); body.appendChild(line);
    });
    preview.hidden = false;
  };
  const request = async (url, body) => {
    const abort = new AbortController(); controller = abort;
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch(url, { signal: abort.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(), { userMessage: data.message || messages.generic_error });
      return data;
    } finally { clearTimeout(timeout); }
  };
  const run = async action => {
    if (busy) return;
    busy = true; const seq = ++revision;
    const disabled = new Map();
    dialog.querySelectorAll('button,input').forEach(node => { disabled.set(node,node.disabled); node.disabled = true; });
    notice.textContent = messages.loading;
    try { await action(); }
    catch (err) {
      if (seq === revision) { invalidate(); notice.textContent = err.name === 'AbortError' ? messages.salary_review_timeout : err.userMessage || messages.generic_error; }
    } finally {
      if (seq === revision) {
        disabled.forEach((wasDisabled, node) => { if (node !== finalize) node.disabled = wasDisabled; });
        finalize.disabled = !hash || uncertain; busy = false;
      }
    }
  };
  const load = async append => {
    const query = new URLSearchParams(append ? { before_id: nextCursor } : { on_date: context.reportEnd });
    const data = await request(`/hr-payroll/payroll/workspace/${context.kind}/${context.entityId}?${query}`);
    if (!append && data.period) {
      form.elements.period_from.value = data.period.from; form.elements.period_to.value = data.period.to;
      if (form.elements.unpaid_days) form.elements.unpaid_days.value = '0';
    }
    const body = dialog.querySelector('[data-payroll-runs]');
    if (!append) body.replaceChildren();
    data.runs.forEach(row => {
      const line = document.createElement('tr'); line.className = 'border-t border-slate-100';
      [date(row.period_from),date(row.period_to),money(row.total_payable)].forEach(value => {
        const cell = document.createElement('td'); cell.className = 'whitespace-nowrap px-3 py-2'; cell.textContent = value; line.appendChild(cell);
      });
      const cell = document.createElement('td'); cell.className = 'px-3 py-2';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-accent underline';
      button.textContent = messages.salary_view_finalized; button.dataset.payrollSnapshot = row.id;
      button.addEventListener('click', () => run(async () => {
        const result = await request(`/hr-payroll/payroll/${context.kind}/${row.id}/snapshot?from_ledger=1`);
        render(result.snapshot, true); notice.textContent = '';
      })); cell.appendChild(button); line.appendChild(cell); body.appendChild(line);
    });
    if (!body.children.length) {
      const line = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 4;
      cell.className = 'px-3 py-3 text-slate-500'; cell.textContent = messages.no_entries; line.appendChild(cell); body.appendChild(line);
    }
    nextCursor = data.nextCursor; more.hidden = !nextCursor;
    notice.textContent = mode === 'close' ? data.periodError || '' : '';
  };
  document.querySelectorAll('[data-payroll-open]').forEach(button => button.addEventListener('click', () => {
    if (busy) return;
    trigger = button; mode = button.dataset.payrollOpen; form.reset(); invalidate();
    title.textContent = messages[mode === 'close' ? 'payroll_close' : 'payroll_history'];
    form.hidden = mode !== 'close'; history.hidden = mode !== 'history';
    dialog.showModal(); run(() => load(false));
  }));
  dialog.querySelector('[data-payroll-close]').addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    controller?.abort(); invalidate(); trigger?.focus();
    if (dirty || uncertain) window.location.assign(context.reloadUrl);
  });
  form.addEventListener('input', invalidate); form.addEventListener('change', invalidate);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || uncertain || !form.reportValidity()) return;
    const body = { ...Object.fromEntries(new FormData(form)), _csrf: csrf, from_ledger: true };
    run(async () => {
      invalidate();
      const data = await request('/hr-payroll/payroll/preview', body);
      render(data.snapshot, false);
      if (data.snapshot.period_to < <%- JSON.stringify(reportData.salaryReviewContext.today) %>) hash = data.hash;
      notice.textContent = hash ? '' : messages.salary_period_not_ended;
    });
  });
  finalize.addEventListener('click', () => {
    if (busy || !hash || uncertain) return;
    const body = { ...Object.fromEntries(new FormData(form)), _csrf: csrf, from_ledger: true, preview_hash: hash };
    run(async () => {
      // If the connection drops, require a reload before retrying a financial close.
      uncertain = true;
      const data = await request('/hr-payroll/payroll/finalize', body);
      uncertain = false; invalidate();
      if (data.queued) { dirty = true; uncertain = true; notice.textContent = `${data.message} ${messages.payroll_queued_help}`; }
      else { dirty = true; window.location.assign(context.reloadUrl); }
    });
  });
  more.addEventListener('click', () => { if (nextCursor) run(() => load(true)); });
})();
