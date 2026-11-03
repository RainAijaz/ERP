(() => {
  const context = <%- JSON.stringify(reportData.salaryReviewContext).replace(/</g, '\\u003c') %>;
  const messages = <%- JSON.stringify({ never:t('salary_review_never'), generic:t('generic_error'), timeout:t('salary_review_timeout') }).replace(/</g, '\\u003c') %>;
  const csrfToken = <%- JSON.stringify(csrfToken).replace(/</g, '\\u003c') %>;
  const dialog = document.querySelector('[data-salary-review-dialog]');
  if (!dialog) return;
  const form = dialog.querySelector('[data-salary-review-form]');
  const error = dialog.querySelector('[data-salary-review-error]');
  const date = form.elements.checked_through;
  let person, busy = false, trigger;
  document.querySelectorAll('[data-salary-review-open]').forEach(button => button.addEventListener('click', () => {
    person = button.closest('[data-salary-review-person]');
    if (!person || busy) return;
    trigger = button;
    document.querySelectorAll('[data-salary-review-menu]').forEach(menu => { menu.open = false; });
    dialog.querySelector('[data-salary-review-name]').textContent = person.dataset.personName;
    dialog.querySelector('[data-salary-review-last]').textContent = person.dataset.checkedThroughDisplay || messages.never;
    dialog.querySelector('[data-salary-review-by]').textContent = person.dataset.checkedBy || '-';
    dialog.querySelector('[data-salary-review-on]').textContent = person.dataset.checkedOn || '-';
    if (date) { date.max = [context.reportEnd, context.today].sort()[0]; date.value = date.max; }
    error.classList.add('hidden');
    dialog.showModal();
    if (date) date.focus();
  }));
  dialog.querySelectorAll('[data-salary-review-close]').forEach(button => button.addEventListener('click', () => { if (!busy) dialog.close(); }));
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { trigger?.focus(); });
  document.addEventListener('click', event => document.querySelectorAll('[data-salary-review-menu][open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!context.canManage || busy || !person || !form.reportValidity()) return;
    busy = true;
    error.classList.add('hidden');
    dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/reports/hr-payroll/salary-review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ _csrf: csrfToken, kind: context.kind, source: context.source, branch_ids: context.branchIds,
          entity_id: person.dataset.entityId, checked_through: date.value, report_end: context.reportEnd,
          expected_review_id: person.dataset.reviewId, report_fingerprint: person.dataset.fingerprint }),
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(), { userMessage: data.message || messages.generic });
      window.location.assign(context.reloadUrl);
    } catch (err) {
      error.textContent = err.name === 'AbortError' ? messages.timeout : err.userMessage || messages.generic;
      error.classList.remove('hidden');
    } finally {
      clearTimeout(timeout); busy = false;
      dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  });
})();
