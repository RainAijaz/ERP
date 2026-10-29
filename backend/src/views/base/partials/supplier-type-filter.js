(function () {
  const init = () => {
    document.querySelectorAll('select[data-supplier-group-filter]').forEach((groupSelect) => {
      if (groupSelect.dataset.supplierGroupReady === 'true') return;
      groupSelect.dataset.supplierGroupReady = 'true';
      const form = groupSelect.form;
      if (!form) return;
      const partySelect = form.querySelector('select[name="party_ids"], select[name="party_id"]');
      if (!partySelect) return;
      // Keep the accessible branch-scoped options so returning to ALL can
      // restore them immediately without a request or a second dropdown system.
      const partyOptions = Array.from(partySelect.options);
      const syncParties = () => {
        const selectedGroups = Array.from(groupSelect.selectedOptions, (option) => option.value);
        const allGroups = !selectedGroups.length || selectedGroups.includes('__ALL__');
        const selectedParties = new Set(Array.from(partySelect.selectedOptions, (option) => option.value));
        const available = partyOptions.filter((option) => !option.value || option.value === '__ALL__' ||
          allGroups || selectedGroups.includes(option.dataset.supplierGroupId));
        partySelect.replaceChildren(...available);
        if (partySelect.multiple) {
          available.forEach((option) => { option.selected = selectedParties.has(option.value); });
          if (!Array.from(partySelect.selectedOptions).length) {
            const fallback = available.find((option) => option.value === '__ALL__');
            if (fallback) fallback.selected = true;
          }
        } else {
          // Moving single-select options can make the browser select the first
          // supplier automatically. Restore an allowed selection explicitly.
          partySelect.value = available.find((option) => selectedParties.has(option.value))?.value || '';
        }
        partySelect.dispatchEvent(new Event('change', { bubbles: true }));
        if (typeof window.refreshSearchableSelects === 'function') window.refreshSearchableSelects(form);
      };
      groupSelect.addEventListener('change', syncParties);
      syncParties();
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
