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
    { name: 'finance.ventures.list', method: 'GET', path: '/finance/ventures', description: 'List every registered venture (raw rows, incl. FOLDER/CATEGORY -- unlike projects.list this does not ping RENDER_URL).' },
    { name: 'finance.ventures.set', method: 'POST', path: '/finance/ventures', description: 'Create or update a venture.' },
    { name: 'finance.ventures.delete', method: 'POST', path: '/finance/ventures/delete', description: 'Discard a venture row entirely (body: {id}) -- for a mis-mapped OneDrive discovery candidate or any venture Sconl wants gone.' },
    { name: 'finance.ventures.discoverIngest', method: 'POST', path: '/finance/ventures/discover-ingest', description: 'Additive-only ingest target for vault\'s OneDrive _ace venture discovery (body: {ventures:[{folder,name}]}) -- never overwrites an existing populated row.' },
    { name: 'finance.possessions.list', method: 'GET', path: '/finance/possessions', description: 'List every registered possession (Holdings\' general asset registry, not money-only).' },
    { name: 'finance.possessions.set', method: 'POST', path: '/finance/possessions', description: 'Create or update a possession (body: {id?, item, category, value, acquiredDate, location, condition, notes}).' },
    { name: 'finance.possessions.delete', method: 'POST', path: '/finance/possessions/delete', description: 'Discard a possession row entirely (body: {id}).' },

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
    { name: 'calendar.export', method: 'GET', path: '/calendar/export', description: 'Export local events + scope/dates.tsv\'s recurring dates as a standard .ics file (JSON-wrapped text, client builds the download). Live Microsoft 365 events are deliberately excluded -- they already exist natively in Outlook.' },

    { name: 'health.data', method: 'GET', path: '/health/data', description: 'Vault data-health checks: corruption, schema drift, task/finance/inbox hygiene.' },

    { name: 'rhythm.get', method: 'GET', path: '/rhythm', description: 'Habit tracker state, with GitHub/learning/journal/task auto-detection.' },
    { name: 'rhythm.update', method: 'POST', path: '/rhythm', description: 'Toggle a habit or replace the habit list.' },
    { name: 'insights.get', method: 'GET', path: '/insights', description: 'Executive-space insight cards, one per domain.' },

    { name: 'projects.list', method: 'GET', path: '/projects', description: 'Venture list, each with a liveness ping against its deployed URL (if one is set).' },
    { name: 'projects.url.set', method: 'POST', path: '/projects/url', description: 'Set or clear a venture\'s deployed URL.' },

    { name: 'portfolio.get', method: 'GET', path: '/portfolio', description: 'Sconl\'s own CV/resume/portfolio document links (BA26090501). Phase 1: a simple curated link list -- not a live portfolio product.' },
    { name: 'portfolio.update', method: 'POST', path: '/portfolio', description: 'Replace the portfolio item list.' },

    { name: 'github.contributions', method: 'GET', path: '/github/contributions', description: 'Cached GitHub contribution calendar.' },
    { name: 'github.snapshot', method: 'GET', path: '/github/snapshot', description: 'User identity, recent repos, and unread notifications, in the shape hub\'s GitHub view renders.' },

    { name: 'news.competitors.list', method: 'GET', path: '/news/competitors', description: 'List tracked venture/org -> competitor rows (BI26091022).' },
    { name: 'news.competitors.set', method: 'POST', path: '/news/competitors', description: 'Create or update a tracked competitor.' },
    { name: 'news.competitors.delete', method: 'POST', path: '/news/competitors/delete', description: 'Remove a tracked competitor (body: {id}).' },
    { name: 'news.topics.list', method: 'GET', path: '/news/topics', description: 'List freeform location/topic tracking terms.' },
    { name: 'news.topics.set', method: 'POST', path: '/news/topics', description: 'Create or update a freeform location/topic term.' },
    { name: 'news.topics.delete', method: 'POST', path: '/news/topics/delete', description: 'Remove a freeform location/topic term (body: {id}).' },
    { name: 'news.terms.list', method: 'GET', path: '/news/terms', description: 'Every active query term the sweep will use this run (competitors + topics + circle career-org mentions), merged and deduped.' },
    { name: 'news.sweep', method: 'POST', path: '/news/sweep', description: 'Query every free-tier news source for every active term; raise a notification + Telegram push for each genuinely new match. Callable manually today -- not yet wired to any recurring scheduler (separate, not-yet-resolved deploy question).' },
  ],
  // Telegram (channel mechanics) and Buffer (post scheduling) are internal
  // capabilities the poll loop and finance/circle flows call directly --
  // not exposed as their own routes yet. Command dispatch and post-authoring
  // UX are deliberately hub/spark concerns, not pulse's (see telegram.js's
  // and buffer.js's own doc comments).
};
