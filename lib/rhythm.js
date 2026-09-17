'use strict';
/**
 * Personal Rhythm: the habit tracker, plus the small adjacent Insights
 * feature it sits beside in the original UI. Ported from isconl-agent's
 * server.js (~9346-9465 rhythm, ~9418-9437 insights).
 *
 * SELF-CAUGHT BUG fixed during this port: the original read the journal
 * auto-detect source as `readTSV('journal.tsv')`, but the journal has always
 * lived at `spark/journal.tsv` (confirmed against VAULT_SCHEMA and every
 * other journal read/write site in server.js) -- so "journal entry today"
 * auto-detection in the habit grid has never actually fired. Fixed here to
 * the real path.
 *
 * CROSS-ENGINE: journal (spark), learning progress (spark), and task
 * completions (scope) are read the same way as every other module -- via
 * the shared readTSV, same reasoning as notifications.js/data-health.js.
 */

// FI26091507: this list used to carry three invented personal habits
// alongside the four below -- "Workout / Exercise", "Deep Reading",
// "Meditation & Focus" -- and `getRhythm` substituted the whole set whenever
// the store was empty. The habit grid then painted seven habits the user had
// never created, visually identical to ones they had, and `updateRhythm`
// only persists `habits` when the client happens to send them, so the store
// could stay empty forever while the screen looked populated. A fallback
// that renders as though it were real data is worse than an empty grid.
//
// The four that remain are not invented content: each one is the display
// side of an auto-detection this engine actually performs below (a commit, a
// learning update, a journal entry, a completed task), so a tick against one
// of them reflects something that really happened. They are marked
// `seeded: true` so a UI can say where they came from rather than presenting
// them as the user's own list.
const AUTO_HABITS = [
  { id: 'h-gh', title: 'GitHub Commits', auto: 'github', icon: '💻', seeded: true },
  { id: 'h-learn', title: 'Learning Module', auto: 'learning', icon: '📚', seeded: true },
  { id: 'h-journal', title: 'Journal Entry', auto: 'journal', icon: '✍️', seeded: true },
  { id: 'h-tasks', title: 'Task Completed', auto: 'tasks', icon: '✅', seeded: true },
];

// FI26091507: there used to be a DEFAULT_INSIGHTS constant here holding five
// hand-written cards -- a fixed "On August 1, 1971, the Concert for
// Bangladesh..." calendar entry, and invented statistics such as "Promoted
// ideas are 4.2x more likely to ship" -- merged under whatever the override
// store supplied. Since `readInsightsOverride` is never actually wired in
// `src/server.js`, the override was always empty, so every insight this
// engine has ever served was fabricated and labelled "Executive Foresight".
// Made-up numbers presented as analysis are the sharpest form of this defect
// class: a reader has no way to tell them from a real measurement, and may
// act on them.
//
// Removed rather than replaced. Insights are now whatever the override store
// holds, and `available` says plainly when that is nothing, so a consumer can
// show an empty state instead of prose. hub already stopped consuming this --
// its /api/insights builds a real card from vault's `onthisday` corpus -- so
// nothing on screen today depends on the constant.

function createRhythmClient(opts) {
  const {
    readTSV,
    readState = async () => ({ habits: [], logs: {} }),
    writeState = async () => {},
    readInsightsOverride = async () => ({}),
  } = opts;
  if (!readTSV) throw new Error('createRhythmClient requires readTSV');

  async function getRhythm(now = new Date()) {
    let rhythm = (await readState()) || { habits: [], logs: {} };
    if (!rhythm.habits || !rhythm.habits.length) rhythm = { ...rhythm, habits: AUTO_HABITS.map(h => ({ ...h })) };
    if (!rhythm.logs) rhythm = { ...rhythm, logs: {} };

    const todayStr = now.toISOString().slice(0, 10);
    rhythm.logs[todayStr] = rhythm.logs[todayStr] || {};

    const journalCounts = {};
    for (const r of (await readTSV('spark/journal.tsv')) || []) {
      const dt = (r.DATE || r.CREATED_AT || '').slice(0, 10);
      if (dt) journalCounts[dt] = (journalCounts[dt] || 0) + 1;
    }
    if (journalCounts[todayStr]) rhythm.logs[todayStr]['h-journal'] = true;

    const learnCounts = {};
    for (const r of (await readTSV('learning/resume.tsv')) || []) {
      const dt = (r.UPDATED_AT || '').slice(0, 10);
      if (dt) learnCounts[dt] = (learnCounts[dt] || 0) + 1;
    }
    if (learnCounts[todayStr]) rhythm.logs[todayStr]['h-learn'] = true;

    const taskCounts = {};
    for (const r of ((await readTSV('scope/tasks.tsv')) || []).filter(r => r.STATUS === 'done')) {
      const dt = (r.UPDATED_AT || r.CREATED_AT || '').slice(0, 10);
      if (dt) taskCounts[dt] = (taskCounts[dt] || 0) + 1;
    }
    if (taskCounts[todayStr]) rhythm.logs[todayStr]['h-tasks'] = true;

    const bySource = { all: [], github: [], learning: [], journal: [], tasks: [], custom: [] };
    for (let i = 364; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      const dayLog = rhythm.logs[d] || {};
      const customCount = Object.entries(dayLog).filter(([k, v]) => v && !['h-gh', 'h-learn', 'h-journal', 'h-tasks'].includes(k)).length;
      const learnC = learnCounts[d] || (dayLog['h-learn'] ? 1 : 0);
      const journalC = journalCounts[d] || (dayLog['h-journal'] ? 1 : 0);
      const taskC = taskCounts[d] || (dayLog['h-tasks'] ? 1 : 0);
      const ghC = dayLog['h-gh'] ? 1 : 0;
      const totalC = customCount + learnC + journalC + taskC + ghC;

      bySource.all.push({ date: d, count: totalC });
      bySource.github.push({ date: d, count: ghC });
      bySource.learning.push({ date: d, count: learnC });
      bySource.journal.push({ date: d, count: journalC });
      bySource.tasks.push({ date: d, count: taskC });
      bySource.custom.push({ date: d, count: customCount });
    }

    return { habits: rhythm.habits, logs: rhythm.logs, days: bySource.all, bySource };
  }

  async function updateRhythm(payload) {
    const existing = (await readState()) || { habits: [], logs: {} };
    if (payload.toggleHabit) {
      const { date, habitId, done } = payload.toggleHabit;
      existing.logs = existing.logs || {};
      existing.logs[date] = existing.logs[date] || {};
      existing.logs[date][habitId] = !!done;
    }
    if (payload.habits) existing.habits = payload.habits;
    await writeState(existing);
    return { success: true, rhythm: existing };
  }

  async function getInsights() {
    const insights = { ...((await readInsightsOverride()) || {}) };
    return { insights, available: Object.keys(insights).length > 0 };
  }

  return { getRhythm, updateRhythm, getInsights };
}

module.exports = { createRhythmClient, AUTO_HABITS };
