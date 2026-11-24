// Example custom rules (rule form v1). Built by build.mjs into build/<slug>.*; the contract tests and the dashboard
// tests use the generated netlists, so these are golden artifacts: changing one changes its netlist hash.

export const EXAMPLES = Object.freeze({
  // "Up to 10 a day."
  'daily-10': {
    v: 1,
    tz: 0,
    appliesTo: ['owner', 'agent', 'beneficiary'],
    anyOf: [{ allOf: [{ fact: 'spent_day', max: '10' }] }],
  },
  // "My son can spend up to 10 a day, only on weekdays, never after 9 pm." The son holds the agent key; the owner is
  // in Lagos (UTC+1).
  son: {
    v: 1,
    tz: 60,
    appliesTo: ['agent'],
    anyOf: [
      {
        allOf: [
          { fact: 'spent_day', max: '10' },
          { fact: 'time', windows: [{ days: [0, 1, 2, 3, 4], from: '00:00', to: '21:00' }] },
        ],
      },
    ],
  },
  // "At most 50 per payment, at most 5 payments a day, only to trusted payees" (for the agent).
  'agent-50-5-trusted': {
    v: 1,
    tz: 0,
    appliesTo: ['agent'],
    anyOf: [
      {
        allOf: [
          { fact: 'amount', max: '50' },
          { fact: 'count_day', max: 5 },
          { fact: 'payee_trusted', is: true },
        ],
      },
    ],
  },
  // "Up to 200 a week, and only to payees known for 48 hours."
  'week-200-48h': {
    v: 1,
    tz: 0,
    appliesTo: ['owner', 'agent', 'beneficiary'],
    anyOf: [{ allOf: [{ fact: 'spent_7d', max: '200' }, { fact: 'payee_age_hours', min: 48 }] }],
  },
  // Inheritance: "If I haven't checked in for 180 days, my daughter may withdraw up to 500 a month."
  inheritance: {
    v: 1,
    tz: 0,
    appliesTo: ['beneficiary'],
    anyOf: [{ allOf: [{ fact: 'checkin_age_hours', min: 4320 }, { fact: 'spent_month', max: '500' }] }],
  },
  // "I can spend up to 10 a day" (limits only the owner: used to test that naming an AI helper, which this rule
  // does not limit, waits like any loosening change).
  'owner-10': {
    v: 1,
    tz: 0,
    appliesTo: ['owner'],
    anyOf: [{ allOf: [{ fact: 'spent_day', max: '10' }] }],
  },
});
