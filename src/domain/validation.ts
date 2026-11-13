import { cents, timestamp, validatePolicy } from './policy.js';
import type { EvaluationInput } from './types.js';

type Row = Record<string, unknown>;
const fail = (path: string, expected: string): never => { throw new Error(`${path}: expected ${expected}`); };
function row(value: unknown, path: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(path, 'a plain object');
  return value as Row;
}
function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail(path, 'an array');
  return value;
}
function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) return fail(path, 'a string' + (allowEmpty ? '' : ' with content'));
  return value;
}
function id(value: unknown, path: string): void {
  const result = text(value, path);
  if (result !== result.trim()) fail(path, 'a nonempty ID without surrounding whitespace');
}
function choice(value: unknown, choices: readonly string[], path: string): void {
  if (typeof value !== 'string' || !choices.includes(value)) fail(path, choices.join(' | '));
}
function bool(value: unknown, path: string): void {
  if (typeof value !== 'boolean') fail(path, 'a boolean');
}
function count(value: unknown, path: string, minimum = 0): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(path, 'a nonnegative integer count');
}
function percent(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) fail(path, 'a percentage between 0 and 100');
}
function money(value: unknown, path: string): void {
  try { cents(value as number); } catch { fail(path, 'nonnegative integer cents'); }
}
function scoped(record: Row, path: string): void {
  id(record.tenantId, `${path}.tenantId`);
  const subject = text(record.subjectKey, `${path}.subjectKey`);
  if (!/^(fan|guest):\S(?:.*\S)?$/.test(subject)) fail(`${path}.subjectKey`, 'fan:<ID> or guest:<ID>');
}
function fresh(record: Row, path: string): void {
  const checked = timestamp(record.checkedAt);
  const until = timestamp(record.validUntil);
  // Expired snapshots are valid evidence, but an inverted validity interval is malformed.
  if (until < checked) fail(path, 'validUntil at or after checkedAt');
}
function knownNumber(value: unknown, path: string, isMoney: boolean): void {
  if (value === 'unknown' || value === 'not_synced') return;
  if (isMoney) money(value, path); else count(value, path);
}
function sourceCents(value: string, path: string): number {
  const [whole, fraction = '00'] = value.slice(1).split('.');
  const result = BigInt(whole!) * 100n + BigInt(fraction);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail(path, 'a safely representable amount in integer cents');
  return Number(result);
}

/** Reject malformed imports before any policy branch runs. Missing records use empty arrays and remain inspectable. */
export function assertInputShape(value: unknown): asserts value is EvaluationInput {
  const input = row(value, 'input');
  const clock = row(input.clock, 'clock');
  if (typeof clock.now !== 'function') fail('clock.now', 'a function returning an explicit-offset timestamp');
  validatePolicy(input.policy);
  for (const [index, value] of list(input.carts, 'carts').entries()) {
    const path = `carts[${index}]`;
    const cart = row(value, path);
    id(cart.tenantId, `${path}.tenantId`);
    id(cart.matchId, `${path}.matchId`);
    timestamp(cart.lastActivityAt);
    money(cart.cartValueCents, `${path}.cartValueCents`);
    percent(cart.sectionSoldPercent, `${path}.sectionSoldPercent`);
    knownNumber(cart.lifetimeTickets, `${path}.lifetimeTickets`, false);
    knownNumber(cart.shopSpendCents, `${path}.shopSpendCents`, true);
    const identity = row(cart.identity, `${path}.identity`);
    choice(identity.kind, ['fan', 'guest'], `${path}.identity.kind`);
    if (identity.kind === 'fan') id(identity.fanId, `${path}.identity.fanId`);
    else {
      id(identity.contactId, `${path}.identity.contactId`);
      for (const candidate of list(identity.associatedFanIds, `${path}.identity.associatedFanIds`)) id(candidate, `${path}.identity.associatedFanIds`);
      if (identity.provenance !== null) text(identity.provenance, `${path}.identity.provenance`, true);
    }
    const source = row(cart.source, `${path}.source`);
    for (const field of ['cartId', 'fanId', 'team', 'match', 'section', 'abandoned', 'lastPurchase']) {
      id(source[field], `${path}.source.${field}`);
    }
    count(source.seats, `${path}.source.seats`, 1);
    choice(source.source, ['Web', 'App'], `${path}.source.source`);
    for (const field of ['seasonPass', 'emailOptIn', 'pushOptIn']) choice(source[field], ['Yes', 'No'], `${path}.source.${field}`);
    if (source.lifetimeTickets !== 'Unknown') count(source.lifetimeTickets, `${path}.source.lifetimeTickets`);
    const sold = text(source.sectionSold, `${path}.source.sectionSold`);
    if (!/^\d+(?:\.\d+)?%$/.test(sold)) fail(`${path}.source.sectionSold`, 'a percentage string');
    percent(Number(sold.slice(0, -1)), `${path}.source.sectionSold`);
    for (const field of ['cartValue', 'shopSpend12Months']) {
      const amount = text(source[field], `${path}.source.${field}`);
      if (field === 'shopSpend12Months' && ['Unknown', 'Not synced'].includes(amount)) continue;
      if (!/^\$\d+(?:\.\d{2})?$/.test(amount)) fail(`${path}.source.${field}`, 'a nonnegative dollar amount');
    }
    const shop = source.shopSpend12Months as string;
    const normalized = {
      cartValueCents: sourceCents(source.cartValue as string, `${path}.source.cartValue`),
      sectionSoldPercent: Number(sold.slice(0, -1)),
      lifetimeTickets: source.lifetimeTickets === 'Unknown' ? 'unknown' : source.lifetimeTickets,
      shopSpendCents: shop === 'Unknown' ? 'unknown' : shop === 'Not synced' ? 'not_synced' : sourceCents(shop, `${path}.source.shopSpend12Months`),
    };
    for (const [field, expected] of Object.entries(normalized)) {
      if (cart[field] !== expected) fail(`${path}.${field}`, 'a value consistent with the retained source row');
    }
    if (identity.kind === 'fan' && identity.fanId !== source.fanId) fail(`${path}.identity.fanId`, 'the source account fan ID');
  }
  const evidence = row(input.evidence, 'evidence');
  for (const name of ['tenants', 'matches', 'opportunities', 'destinations', 'consents', 'contacts', 'commercial']) {
    for (const [index, value] of list(evidence[name], `evidence.${name}`).entries()) {
      const path = `evidence.${name}[${index}]`;
      const record = row(value, path);
      id(record.tenantId, `${path}.tenantId`);
      if (name !== 'tenants' && name !== 'matches') scoped(record, path);
      if (['matches', 'opportunities', 'contacts', 'commercial'].includes(name)) id(record.matchId, `${path}.matchId`);
      if (['matches', 'opportunities', 'consents', 'commercial'].includes(name)) fresh(record, path);
      switch (name) {
        case 'tenants': bool(record.active, `${path}.active`); break;
        case 'matches':
          timestamp(record.kickoffAt);
          choice(record.state, ['scheduled', 'played', 'cancelled'], `${path}.state`);
          for (const [section, value] of Object.entries(row(record.availableSeatsBySection, `${path}.availableSeatsBySection`))) {
            id(section, `${path}.section`); count(value, `${path}.availableSeatsBySection.${section}`);
          }
          for (const [section, value] of Object.entries(row(record.sectionSoldPercentBySection, `${path}.sectionSoldPercentBySection`))) {
            id(section, `${path}.section`); percent(value, `${path}.sectionSoldPercentBySection.${section}`);
          }
          break;
        case 'opportunities':
          choice(record.purchase, ['not_purchased', 'purchased', 'unknown'], `${path}.purchase`);
          bool(record.recoveryHistoryComplete, `${path}.recoveryHistoryComplete`);
          bool(record.clubHistoryComplete, `${path}.clubHistoryComplete`);
          choice(record.entitlement, ['unknown', 'additional_seats', 'cart_fully_covered'], `${path}.entitlement`);
          if (record.preferredChannel !== null) choice(record.preferredChannel, ['email', 'push'], `${path}.preferredChannel`);
          if (record.recipientTimeZone !== null) text(record.recipientTimeZone, `${path}.recipientTimeZone`, true);
          break;
        case 'destinations':
          choice(record.channel, ['email', 'push'], `${path}.channel`);
          text(record.value, `${path}.value`, true);
          bool(record.verifiedOwner, `${path}.verifiedOwner`);
          choice(record.status, ['usable', 'invalid', 'revoked'], `${path}.status`);
          break;
        case 'consents':
          choice(record.channel, ['email', 'push'], `${path}.channel`);
          choice(record.purpose, ['marketing', 'transactional'], `${path}.purpose`);
          choice(record.status, ['granted', 'revoked'], `${path}.status`);
          text(record.provenance, `${path}.provenance`, true);
          if (timestamp(record.effectiveAt) > timestamp(record.checkedAt)) fail(`${path}.effectiveAt`, 'an event time at or before checkedAt');
          break;
        case 'contacts':
          timestamp(record.at);
          choice(record.kind, ['recovery', 'other_engine_marketing'], `${path}.kind`);
          choice(record.state, ['accepted', 'pending', 'unknown'], `${path}.state`);
          break;
        case 'commercial':
          id(record.cartId, `${path}.cartId`);
          choice(record.currency, ['USD'], `${path}.currency`);
          for (const name of ['eligibleSubtotalCents', 'minimumNetCents', 'maximumDiscountCents']) money(record[name], `${path}.${name}`);
          percent(record.maximumPercent, `${path}.maximumPercent`);
          bool(record.approved, `${path}.approved`);
          text(record.provenance, `${path}.provenance`, true);
          break;
      }
    }
  }
}
