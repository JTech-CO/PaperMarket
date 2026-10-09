import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { inspect } from 'node:util';
import {
  ActiveTickClock, FakeClock, SystemClock, TICK_INTERVAL_MILLISECONDS,
  TICKS_PER_VIRTUAL_MONTH, TICKS_PER_VIRTUAL_QUARTER, TICKS_PER_VIRTUAL_YEAR,
} from '../src/domain/clock.js';
import { utcTimestampSchema } from '../src/domain/identifiers.js';
import {
  DeterministicRandom, digestToUniformDecimal, encodeRandomContext,
  randomContextSchema, RANDOM_ALGORITHM,
} from '../src/domain/random.js';

const initialTime = '2026-10-03T12:00:00.000Z';
const context = randomContextSchema.parse({
  engineVersion: '0.0.0', tick: 63, issuerId: 'issuer-HGI', eventChannel: 'earnings', drawIndex: 0,
});

test('fake wall clock is monotonic, explicit and uses canonical UTC', () => {
  const clock = new FakeClock(initialTime);
  assert.equal(clock.now(), initialTime);
  assert.equal(clock.advanceBy(1), '2026-10-03T12:00:00.001Z');
  assert.throws(() => clock.advanceBy(-1), RangeError);
  assert.throws(() => clock.advanceBy(0.5), RangeError);
  assert.throws(() => clock.set(initialTime), RangeError);
  assert.equal(utcTimestampSchema.safeParse(new SystemClock().now()).success, true);
  assert.deepEqual([TICKS_PER_VIRTUAL_MONTH, TICKS_PER_VIRTUAL_QUARTER, TICKS_PER_VIRTUAL_YEAR], [21, 63, 252]);
});

test('active elapsed time excludes pauses and becomes due only once', () => {
  const wall = new FakeClock(initialTime);
  const active = new ActiveTickClock(wall);
  wall.advanceBy(100_000);
  active.pause();
  wall.advanceBy(7 * 24 * 60 * 60 * 1_000);
  assert.equal(active.elapsedMilliseconds(), 100_000);
  active.resume();
  wall.advanceBy(199_999);
  assert.equal(active.remainingMilliseconds(), 1);
  wall.advanceBy(1);
  assert.equal(active.elapsedMilliseconds(), TICK_INTERVAL_MILLISECONDS);
  wall.advanceBy(7 * 24 * 60 * 60 * 1_000);
  assert.equal(active.elapsedMilliseconds(), TICK_INTERVAL_MILLISECONDS);
  assert.equal(active.remainingMilliseconds(), 0);
});

test('checkpoint recovery keeps durable elapsed time and excludes offline time', () => {
  const wall = new FakeClock(initialTime);
  const before = new ActiveTickClock(wall);
  wall.advanceBy(100_000);
  const checkpoint = before.checkpoint();
  wall.advanceBy(14 * 24 * 60 * 60 * 1_000);
  const recovered = new ActiveTickClock(wall, checkpoint);
  assert.equal(recovered.elapsedMilliseconds(), 100_000);
  assert.equal(recovered.remainingMilliseconds(), 200_000);
  wall.advanceBy(200_000);
  assert.equal(recovered.remainingMilliseconds(), 0);
  assert.throws(() => new ActiveTickClock(new FakeClock(initialTime), checkpoint), /Checkpoint cannot be later/);
});

test('paused checkpoint remains paused after recovery until explicit resume', () => {
  const wall = new FakeClock(initialTime);
  const before = new ActiveTickClock(wall);
  wall.advanceBy(10_000);
  before.pause();
  const checkpoint = before.checkpoint();
  wall.advanceBy(500_000);
  const recovered = new ActiveTickClock(wall, checkpoint);
  wall.advanceBy(500_000);
  assert.equal(recovered.elapsedMilliseconds(), 10_000);
  recovered.resume();
  wall.advanceBy(1);
  assert.equal(recovered.elapsedMilliseconds(), 10_001);
});

test('random context encoding has a fixed unambiguous golden representation', () => {
  assert.equal(encodeRandomContext(context),
    '["papermarket-hmac-sha256-v1","0.0.0",63,"issuer-HGI","earnings",0]');
  assert.equal(randomContextSchema.safeParse({ ...context, drawIndex: -1 }).success, false);
  assert.equal(randomContextSchema.safeParse({ ...context, eventChannel: 'a'.repeat(65) }).success, false);
  assert.equal(randomContextSchema.safeParse({ ...context, accountId: 'account-1' }).success, false);
});

test('public digest conversion golden vectors preserve exact 256 bit fractions', () => {
  assert.equal(digestToUniformDecimal(Buffer.alloc(32)), '0');
  const half = Buffer.alloc(32);
  half[0] = 0x80;
  assert.equal(digestToUniformDecimal(half), '0.5');
  assert.equal(digestToUniformDecimal(Buffer.alloc(32, 0xff)),
    '0.9999999999999999999999999999999999999999999999999999999999999999999999999999913638314449055553746136481371996004288839996355637186149762965298314081968375729420284924965277117734394527060538503364030049010531680533063469962229419252253137528896331787109375');
  assert.throws(() => digestToUniformDecimal(Buffer.alloc(31)), RangeError);
});

test('injected secret produces replayable draws independent of call order and consumption', () => {
  const injected = randomBytes(32);
  const random = new DeterministicRandom(injected);
  const expected = createHmac('sha256', injected)
    .update('["papermarket-hmac-sha256-v1","0.0.0",63,"issuer-HGI","earnings",0]', 'utf8').digest('hex');
  assert.equal(random.digestHex(context), expected);
  random.uniform({ ...context, drawIndex: 999 });
  random.uniform({ ...context, eventChannel: 'macro' });
  assert.equal(random.digestHex(context), expected);
  assert.equal(new DeterministicRandom(injected).digestHex(context), expected);
  for (const different of [
    { ...context, engineVersion: randomContextSchema.parse({ ...context, engineVersion: '0.0.1' }).engineVersion },
    randomContextSchema.parse({ ...context, tick: 64 }),
    randomContextSchema.parse({ ...context, issuerId: 'issuer-DNL' }),
    { ...context, eventChannel: 'dividend' }, { ...context, drawIndex: 1 },
  ]) assert.notEqual(random.digestHex(different), expected);
  const uniform = random.uniform(context);
  assert.match(uniform, /^0(?:\.\d{1,256})?$/);
  assert.equal(uniform, digestToUniformDecimal(Buffer.from(expected, 'hex')));
  injected.fill(0); // The engine owns a defensive copy of the injected buffer.
  assert.equal(random.digestHex(context), expected);
});

test('random object JSON, inspection and enumerable fields never contain its seed', () => {
  const injected = randomBytes(32);
  const random = new DeterministicRandom(injected);
  assert.deepEqual(Object.keys(random), []);
  assert.equal(JSON.stringify(random), JSON.stringify({ algorithm: RANDOM_ALGORITHM }));
  assert.equal(inspect(random).includes(injected.toString('hex')), false);
  assert.equal(JSON.stringify(random).includes('secret'), false);
  assert.throws(() => new DeterministicRandom(randomBytes(31)), RangeError);
  assert.throws(() => new DeterministicRandom(randomBytes(65)), RangeError);
});
