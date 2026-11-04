"use strict";

const { toLocalDateOnly } = require("../../utils/date-only");

// Cards, branch totals and charts share one business-date anchor, even when the
// server runs in UTC. Match the reporting timezone used by activity reports.
const resolveDashboardPeriod = ({ mode, now = new Date() } = {}) => {
  const timeZone = String(
    process.env.ERP_REPORT_TIME_ZONE || process.env.TZ || "Asia/Karachi",
  ).trim() || "Asia/Karachi";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const dateParts = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const anchor = new Date(`${today}T00:00:00Z`);
  const shifted = (days) => {
    const date = new Date(anchor);
    date.setUTCDate(date.getUTCDate() + days);
    return toLocalDateOnly(date.toISOString());
  };
  const calendar = mode === "calendar";
  const weekFrom = calendar ? shifted(-((anchor.getUTCDay() + 6) % 7)) : shifted(-6);
  const monthFrom = calendar ? `${today.slice(0, 7)}-01` : shifted(-29);
  return {
    mode: calendar ? "calendar" : "rolling",
    today,
    yesterday: shifted(-1),
    week: { from: weekFrom, to: today },
    month: { from: monthFrom, to: today },
    generatedAt: now.toISOString(),
  };
};

module.exports = { resolveDashboardPeriod };
