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

const DEFAULT_HABITS = [
  { id: 'h-gh', title: 'GitHub Commits', auto: 'github', icon: '💻' },
  { id: 'h-learn', title: 'Learning Module', auto: 'learning', icon: '📚' },
  { id: 'h-journal', title: 'Journal Entry', auto: 'journal', icon: '✍️' },
  { id: 'h-tasks', title: 'Task Completed', auto: 'tasks', icon: '✅' },
  { id: 'h-exercise', title: 'Workout / Exercise', auto: null, icon: '🏋️' },
  { id: 'h-read', title: 'Deep Reading', auto: null, icon: '📖' },
  { id: 'h-meditate', title: 'Meditation & Focus', auto: null, icon: '🧘' },
];

const DEFAULT_INSIGHTS = {
  calendar: { title: 'Temporal Alignment', category: 'Today in History', text: 'On August 1, 1971, the Concert for Bangladesh pioneered global music philanthropy. Structure your day with singular focus.', tone: 'gold' },
  ideas: { title: 'Spark & Innovation Insight', category: 'Executive Foresight', text: 'Great products come from ruthless iteration. Promoted ideas are 4.2x more likely to ship when paired with a clear Definition of Done.', tone: 'cyan' },
  planning: { title: 'Strategic Wisdom', category: 'Execution Discipline', text: 'Runway is measured by delivered software, not drafted roadmaps. Focus on closing open rungs in the fortnight sprint.', tone: 'violet' },
  finance: { title: 'Asset Preservation & Growth', category: '50/30/20 Rule', text: 'Target 50% Needs, 30% Wants, and 20% Savings. Keeping variable wants under target secures a high liquidity buffer.', tone: 'green' },
  rhythm: { title: 'Personal Peak Performance', category: 'Consistency & Momentum', text: 'Discipline is consistency over intensity. Small daily habit check-ins compound into sovereign execution power.', tone: 'green' },
};

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
    if (!rhythm.habits || !rhythm.habits.length) rhythm = { ...rhythm, habits: DEFAULT_HABITS };
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
    const override = (await readInsightsOverride()) || {};
    return { insights: { ...DEFAULT_INSIGHTS, ...override } };
  }

  return { getRhythm, updateRhythm, getInsights };
}

module.exports = { createRhythmClient, DEFAULT_HABITS, DEFAULT_INSIGHTS };
