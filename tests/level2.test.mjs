import assert from 'node:assert/strict';
import { buildSweeps, parseLevel2 } from '../js/level2.js';

const putAscii = (bytes, offset, text, length = text.length) => {
  for (let i = 0; i < length; i++) bytes[offset + i] = text.charCodeAt(i) || 0x20;
};

function legacyMessage1Volume() {
  // 24-byte Archive-II volume header + one 12-byte CTM record + one fixed
  // 2432-byte Message-1 record.
  const bytes = new Uint8Array(24 + 12 + 2432);
  const dv = new DataView(bytes.buffer);
  putAscii(bytes, 0, 'ARCHIVE2.', 9);
  putAscii(bytes, 20, 'KTLX', 4);
  dv.setUint16(28, 2432); // uncompressed CTM marker, not an LDM/BZh stream

  const header = 24 + 12;
  dv.setUint16(header, 1216); // fixed record length in halfwords
  dv.setUint8(header + 3, 1); // Message Type 1
  const body = header + 16;
  dv.setUint32(body, 3_600_000); // 01:00:00Z
  dv.setUint16(body + 4, 19_000);
  dv.setInt16(body + 6, 2300);
  dv.setUint16(body + 8, Math.round(90 / (360 / 65536)));
  dv.setUint16(body + 10, 91);
  dv.setUint16(body + 12, 1);
  dv.setUint16(body + 14, Math.round(0.5 / (360 / 65536)));
  dv.setUint16(body + 16, 1);
  dv.setInt16(body + 18, 500);
  dv.setInt16(body + 20, -375);
  dv.setUint16(body + 22, 1000);
  dv.setUint16(body + 24, 250);
  dv.setUint16(body + 26, 4);
  dv.setUint16(body + 28, 4);
  dv.setUint16(body + 30, 1);
  dv.setUint16(body + 36, 100);
  dv.setUint16(body + 38, 104);
  dv.setUint16(body + 40, 108);
  dv.setUint16(body + 42, 2);
  dv.setInt16(body + 60, 2550);
  bytes.set([2, 66, 68, 70], body + 100);
  bytes.set([2, 127, 129, 131], body + 104);
  bytes.set([2, 129, 131, 133], body + 108);
  return bytes;
}

{
  const volume = parseLevel2(legacyMessage1Volume());
  assert.equal(volume.icao, 'KTLX');
  assert.equal(volume.messageType, 1);
  assert.equal(volume.supportsSuperRes, false);
  assert.equal(volume.radials.length, 1);
  const radial = volume.radials[0];
  assert.ok(Math.abs(radial.azimuth - 90) < 0.01);
  assert.ok(Math.abs(radial.elevation - 0.5) < 0.01);
  assert.equal(radial.nyquist, 25.5);
  assert.deepEqual([...radial.moments.REF.raw], [2, 66, 68, 70]);
  assert.equal(radial.moments.REF.firstGate, 500);
  assert.equal(radial.moments.REF.gateSpacing, 1000);
  assert.equal(radial.moments.REF.value(1), 0);
  assert.equal(radial.moments.VEL.firstGate, -375);
  assert.equal(radial.moments.VEL.value(1), -1);
  assert.equal(radial.moments.SW.value(3), 2);

  const sweeps = buildSweeps(volume);
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].supportsSuperRes, false);
  assert.deepEqual([...sweeps[0].moments].sort(), ['REF', 'SW', 'VEL']);
}

assert.throws(
  () => parseLevel2(new Uint8Array(64)),
  /no supported radial data/
);

console.log('level2 tests passed');
