import assert from 'node:assert/strict';
import { alertActiveAt, alertsRequestUrl } from '../js/alerts.js';

const at = new Date('2026-07-12T20:15:00Z');
const feature = (overrides = {}) => ({
  properties: {
    messageType: 'Alert',
    sent: '2026-07-12T19:55:00Z',
    onset: '2026-07-12T20:00:00Z',
    expires: '2026-07-12T20:30:00Z',
    ...overrides,
  },
});

assert.equal(alertActiveAt(feature(), at), true);
assert.equal(alertActiveAt(feature({ sent: '2026-07-12T20:20:00Z' }), at), false,
  'an update issued after the selected scan must not replace its predecessor');
assert.equal(alertActiveAt(feature({ messageType: 'Cancel' }), at), false);
assert.equal(alertActiveAt(feature({ expires: '2026-07-12T20:15:00Z' }), at), false);
assert.equal(alertActiveAt(feature({ expires: null }), at), true);

assert.match(alertsRequestUrl(null), /alerts\/active/);
const historical = new URL(alertsRequestUrl(at));
assert.equal(historical.pathname, '/alerts');
assert.equal(historical.searchParams.get('status'), 'actual');
assert.equal(historical.searchParams.get('message_type'), 'alert,update,cancel');
assert.equal(historical.searchParams.get('end'), '2026-07-12T20:30:00Z');
assert.equal(historical.searchParams.get('start'), '2026-07-11T08:00:00Z');

console.log('alert archive tests passed');
