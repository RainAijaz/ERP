$ErrorActionPreference = "Stop"

$path = "backend/src/views/reports/purchases.ejs"
$content = Get-Content -Raw -Path $path
$startMarker = '<section class="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm" data-report-print-area>'
$endMarker = '<script><%- include("../base/partials/date-range-picker.js") %></script>'

$startIndex = $content.IndexOf($startMarker)
$endIndex = $content.IndexOf($endMarker)
if ($startIndex -lt 0 -or $endIndex -lt 0 -or $endIndex -le $startIndex) {
  throw "Could not locate report section boundaries in purchases.ejs."
}

$prefix = $content.Substring(0, $startIndex - 2)
$suffix = $content.Substring($endIndex)

$newSection = @'
  <section class="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm" data-report-print-area>
    <div class="flex items-center justify-end gap-2" data-report-controls>
      <button type="button" class="inline-flex items-center rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-slate-700 disabled:opacity-40" data-print-report <%= reportLoaded && hasData ? "" : "disabled" %>><%= t("print") %></button>
      <button type="button" class="inline-flex items-center rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-white shadow-sm disabled:opacity-40" data-download-report <%= reportLoaded && hasData ? "" : "disabled" %>><%= t("download") %></button>
    </div>

    <% if (!reportLoaded) { %>
      <div class="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-10 text-center text-2xl font-display text-slate-500"><%= t("load_report_to_view") %></div>
    <% } else if (!hasData) { %>
      <div class="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-10 text-center text-2xl font-display text-slate-500"><%= t("no_entries") %></div>
    <% } else { %>
      <div class="mt-3 rounded-xl border border-rose-200 bg-rose-50/60 px-3 py-2 text-xs font-semibold text-rose-700">
        <%= `${t("rate_alert_legend")}: ${t("high_variance")} (${t("rate_difference")} >= ${formatNumber(rateAlertPercent, 2)}%)` %>
      </div>

      <% if (reportType === "details") { %>
        <div class="relative mt-3 overflow-x-auto rounded-2xl border border-slate-200">
          <table class="min-w-[1520px] w-full text-sm tabular-nums" data-report-table>
            <thead class="bg-slate-100 text-slate-700">
              <tr>
                <% if (orderBy !== "invoice") { %>
                  <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em]"><%= t("voucher_no") %></th>
                <% } %>
                <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em]"><%= t("date") %></th>
                <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em]"><%= t("bill_number") %></th>
                <% if (orderBy !== "party") { %>
                  <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em]"><%= t("party_name") %></th>
                <% } %>
                <% if (orderBy !== "product") { %>
                  <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em]"><%= t("raw_material") %></th>
                <% } %>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("quantity") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("current_purchase_rate") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("fixed_purchase_rate") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("weighted_average_rate") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("variance_amount") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("variance_percent") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("amount") %></th>
                <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em]"><%= t("branch") %></th>
              </tr>
            </thead>
            <tbody>
              <% groups.forEach((group) => { %>
                <tr class="bg-slate-700 text-white">
                  <td colspan="<%= detailColumnCount %>" class="px-3 py-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <% if (orderBy === "invoice") { %>
                        <span class="rounded-md border border-white/40 bg-white/20 px-2 py-0.5 text-xs font-semibold text-white">#<%= group.voucher_no || "-" %></span>
                        <span class="rounded-md border border-white/30 bg-white/10 px-2 py-0.5 text-xs font-semibold text-white"><%= formatDate(group.voucher_date) %></span>
                        <span class="rounded-md border border-white/30 bg-white/10 px-2 py-0.5 text-xs font-semibold text-white"><%= group.supplier_name || "-" %></span>
                      <% } else { %>
                        <span class="rounded-md border border-white/40 bg-white/20 px-2 py-0.5 text-xs font-semibold text-white"><%= group.label %></span>
                      <% } %>
                    </div>
                  </td>
                </tr>
                <% (group.lines || []).forEach((line) => { %>
                  <tr class="bg-white odd:bg-slate-50 even:bg-white hover:bg-slate-100">
                    <% if (orderBy !== "invoice") { %>
                      <td class="px-3 py-2"><%= line.voucher_no %></td>
                    <% } %>
                    <td class="px-3 py-2"><%= formatDate(line.voucher_date) %></td>
                    <td class="px-3 py-2"><%= line.bill_number || "-" %></td>
                    <% if (orderBy !== "party") { %>
                      <td class="px-3 py-2"><%= line.supplier_name || "-" %></td>
                    <% } %>
                    <% if (orderBy !== "product") { %>
                      <td class="px-3 py-2"><%= line.item_name || "-" %></td>
                    <% } %>
                    <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(line.qty, 3) %></td>
                    <td class="px-3 py-2 text-right <%= line.is_rate_difference_high ? 'font-extrabold text-rose-700' : 'font-semibold' %>" title="<%= `${t('rate_difference')}: ${formatNumber(line.rate_diff_percent, 2)}% | ${t('high_variance_threshold')}: ${formatNumber(rateAlertPercent, 2)}%` %>">
                      <div class="inline-flex items-center justify-end gap-1.5">
                        <span><%= formatNumber(line.rate, 4) %></span>
                        <% if (line.is_rate_difference_high) { %>
                          <span class="inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-rose-700"><%= t("high_variance") %></span>
                        <% } %>
                      </div>
                    </td>
                    <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(line.fixed_purchase_rate, 4) %></td>
                    <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(line.weighted_average_rate, 4) %></td>
                    <td class="px-3 py-2 text-right font-semibold <%= line.is_rate_difference_high ? 'text-rose-700' : '' %>"><%= formatNumber(line.rate_diff_amount, 4) %></td>
                    <td class="px-3 py-2 text-right font-semibold <%= line.is_rate_difference_high ? 'text-rose-700' : '' %>"><%= formatNumber(line.rate_diff_percent, 2) %>%</td>
                    <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(line.amount, 2) %></td>
                    <td class="px-3 py-2"><%= line.branch_name || "-" %></td>
                  </tr>
                <% }) %>
                <tr class="bg-accent text-white">
                  <td colspan="<%= detailTotalsLabelSpan %>" class="px-3 py-2 text-right text-xs font-extrabold uppercase tracking-[0.08em]"><%= t("total") %></td>
                  <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(group.total_qty, 3) %></td>
                  <td class="px-3 py-2 text-right font-semibold" title="<%= `${t('rate_difference')}: ${formatNumber(group.avg_variance_percent, 2)}% | ${t('high_variance_threshold')}: ${formatNumber(rateAlertPercent, 2)}%` %>">
                    <div class="inline-flex items-center justify-end gap-1.5">
                      <span><%= formatNumber(group.avg_rate, 4) %></span>
                      <% if (group.is_rate_difference_high) { %>
                        <span class="inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-rose-700"><%= t("high_variance") %></span>
                      <% } %>
                    </div>
                  </td>
                  <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(group.avg_fixed_purchase_rate, 4) %></td>
                  <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(group.avg_weighted_average_rate, 4) %></td>
                  <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(group.avg_variance_amount, 4) %></td>
                  <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(group.avg_variance_percent, 2) %>%</td>
                  <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(group.total_amount, 2) %></td>
                  <td class="px-3 py-2"></td>
                </tr>
              <% }) %>
              <tr class="bg-rose-700 text-white">
                <td colspan="<%= detailTotalsLabelSpan %>" class="px-3 py-2 text-right text-xs font-extrabold uppercase tracking-[0.08em]"><%= t("grand_total") %></td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandTotalQty, 3) %></td>
                <td class="px-3 py-2 text-right font-extrabold" title="<%= `${t('rate_difference')}: ${formatNumber(grandAvgVariancePercent, 2)}% | ${t('high_variance_threshold')}: ${formatNumber(rateAlertPercent, 2)}%` %>">
                  <div class="inline-flex items-center justify-end gap-1.5">
                    <span><%= formatNumber(grandAvgRate, 4) %></span>
                    <% if (isGrandRateDifferenceHigh) { %>
                      <span class="inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-rose-700"><%= t("high_variance") %></span>
                    <% } %>
                  </div>
                </td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandAvgFixedPurchaseRate, 4) %></td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandAvgWeightedAverageRate, 4) %></td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandAvgVarianceAmount, 4) %></td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandAvgVariancePercent, 2) %>%</td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandTotalAmount, 2) %></td>
                <td class="px-3 py-2"></td>
              </tr>
            </tbody>
          </table>
        </div>
      <% } else { %>
        <div class="relative mt-3 overflow-x-auto rounded-2xl border border-slate-200">
          <table class="min-w-[1320px] w-full text-sm tabular-nums" data-report-table>
            <thead class="bg-slate-100 text-slate-700">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em]"><%= t("group") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("quantity") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("current_purchase_rate") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("fixed_purchase_rate") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("weighted_average_rate") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("variance_amount") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("variance_percent") %></th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.08em]"><%= t("amount") %></th>
              </tr>
            </thead>
            <tbody>
              <% summaryRows.forEach((row) => { %>
                <tr class="bg-slate-700 text-white">
                  <td colspan="8" class="px-3 py-2 font-semibold">
                    <div class="flex flex-wrap items-center gap-2">
                      <% if (orderBy === "invoice") { %>
                        <span class="rounded-md border border-white/40 bg-white/20 px-2 py-0.5 text-xs font-semibold text-white">#<%= row.voucher_no || "-" %></span>
                        <span class="rounded-md border border-white/30 bg-white/10 px-2 py-0.5 text-xs font-semibold text-white"><%= formatDate(row.voucher_date) %></span>
                        <span class="rounded-md border border-white/30 bg-white/10 px-2 py-0.5 text-xs font-semibold text-white"><%= row.supplier_name || "-" %></span>
                      <% } else { %>
                        <span class="rounded-md border border-white/40 bg-white/20 px-2 py-0.5 text-xs font-semibold text-white"><%= row.group_label || "-" %></span>
                      <% } %>
                    </div>
                  </td>
                </tr>
                <tr class="bg-accent text-white">
                  <td class="px-3 py-2 text-right text-xs font-extrabold uppercase tracking-[0.08em]"><%= t("total") %></td>
                  <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(row.total_qty, 3) %></td>
                  <td class="px-3 py-2 text-right font-semibold" title="<%= `${t('rate_difference')}: ${formatNumber(row.avg_variance_percent, 2)}% | ${t('high_variance_threshold')}: ${formatNumber(rateAlertPercent, 2)}%` %>">
                    <div class="inline-flex items-center justify-end gap-1.5">
                      <span><%= formatNumber(row.avg_rate, 4) %></span>
                      <% if (row.is_rate_difference_high) { %>
                        <span class="inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-rose-700"><%= t("high_variance") %></span>
                      <% } %>
                    </div>
                  </td>
                  <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(row.avg_fixed_purchase_rate, 4) %></td>
                  <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(row.avg_weighted_average_rate, 4) %></td>
                  <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(row.avg_variance_amount, 4) %></td>
                  <td class="px-3 py-2 text-right font-semibold"><%= formatNumber(row.avg_variance_percent, 2) %>%</td>
                  <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(row.total_amount, 2) %></td>
                </tr>
              <% }) %>
              <tr class="bg-rose-700 text-white">
                <td class="px-3 py-2 text-right text-xs font-extrabold uppercase tracking-[0.08em]"><%= t("grand_total") %></td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandTotalQty, 3) %></td>
                <td class="px-3 py-2 text-right font-extrabold" title="<%= `${t('rate_difference')}: ${formatNumber(grandAvgVariancePercent, 2)}% | ${t('high_variance_threshold')}: ${formatNumber(rateAlertPercent, 2)}%` %>">
                  <div class="inline-flex items-center justify-end gap-1.5">
                    <span><%= formatNumber(grandAvgRate, 4) %></span>
                    <% if (isGrandRateDifferenceHigh) { %>
                      <span class="inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-rose-700"><%= t("high_variance") %></span>
                    <% } %>
                  </div>
                </td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandAvgFixedPurchaseRate, 4) %></td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandAvgWeightedAverageRate, 4) %></td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandAvgVarianceAmount, 4) %></td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandAvgVariancePercent, 2) %>%</td>
                <td class="px-3 py-2 text-right font-extrabold"><%= formatNumber(grandTotalAmount, 2) %></td>
              </tr>
            </tbody>
          </table>
        </div>
      <% } %>
    <% } %>
  </section>

'@

Set-Content -Path $path -Value ($prefix + $newSection + $suffix)
