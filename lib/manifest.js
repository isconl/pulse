'use strict';
/**
 * pulse's capability manifest -- what this engine can do, for hub (or any
 * orchestrator) to discover without hardcoding knowledge of pulse's routes.
 * Same lightweight MCP-tool-list stand-in as vault's manifest (Decision 003).
 */
module.exports = {
  engine: 'pulse',
  version: require('../package.json').version,
  description: 'The "watches other systems, surfaces state" cluster: finance, notifications, dates/calendar, data health, personal rhythm/insights, project status, GitHub, Buffer, Telegram.',
  capabilities: [
    { name: 'finance.summary', method: 'GET', path: '/finance/summary', description: 'Net worth, month income/expense, burn, runway, income streams, allocation model.' },
    { name: 'finance.accounts.set', method: 'POST', path: '/finance/accounts', description: 'Create or update an account.' },
    { name: 'finance.transactions.add', method: 'POST', path: '/finance/transactions', description: 'Log a transaction.' },
    { name: 'finance.incomes.set', method: 'POST', path: '/finance/incomes', description: 'Create or update an income stream.' },
    { name: 'finance.ventures.set', method: 'POST', path: '/finance/ventures', description: 'Create or update a venture.' },

    { name: 'notifications.list', method: 'GET', path: '/notifications', description: 'List notifications, newest first.' },
    { name: 'notifications.sweep', method: 'POST', path: '/notifications/sweep', description: 'Check every source and raise new notifications.' },
    { name: 'notifications.seen', method: 'POST', path: '/notifications/seen', description: 'Mark notifications seen/acted/new.' },

    { name: 'dates.list', method: 'GET', path: '/dates', description: 'Important dates with computed milestones.' },
    { name: 'dates.add', method: 'POST', path: '/dates', description: 'Add an important date.' },
    { name: 'dates.delete', method: 'POST', path: '/dates/delete', description: 'Remove an important date.' },
    { name: 'dates.remind', method: 'POST', path: '/dates/remind', description: 'Send due milestone reminders.' },

    { name: 'calendar.events.list', method: 'GET', path: '/calendar/events', description: 'List local + Microsoft 365 calendar events.' },
    { name: 'calendar.events.add', method: 'POST', path: '/calendar/events', description: 'Add a local event, optionally creating a linked task.' },
    { name: 'calendar.events.delete', method: 'POST', path: '/calendar/events/delete', description: 'Remove a calendar event.' },
    { name: 'calendar.import', method: 'POST', path: '/calendar/import', description: 'Import events from Microsoft 365 or a pasted .ics file.' },

    { name: 'health.data', method: 'GET', path: '/health/data', description: 'Vault data-health checks: corruption, schema drift, task/finance/inbox hygiene.' },

    { name: 'rhythm.get', method: 'GET', path: '/rhythm', description: 'Habit tracker state, with GitHub/learning/journal/task auto-detection.' },
    { name: 'rhythm.update', method: 'POST', path: '/rhythm', description: 'Toggle a habit or replace the habit list.' },
    { name: 'insights.get', method: 'GET', path: '/insights', description: 'Executive-space insight cards, one per domain.' },

    { name: 'projects.list', method: 'GET', path: '/projects', description: 'Venture list with live Render-URL ping status.' },
    { name: 'projects.url.set', method: 'POST', path: '/projects/url', description: 'Set or clear a venture\'s deployed URL.' },

    { name: 'github.contributions', method: 'GET', path: '/github/contributions', description: 'Cached GitHub contribution calendar.' },
  ],
  // Telegram (channel mechanics) and Buffer (post scheduling) are internal
  // capabilities the poll loop and finance/circle flows call directly --
  // not exposed as their own routes yet. Command dispatch and post-authoring
  // UX are deliberately hub/spark concerns, not pulse's (see telegram.js's
  // and buffer.js's own doc comments).
};
