import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facettePayment } from './facettes.js';

const augustin = (bonus) => ({ custom_data: { threshold_percent: 60, facette_bonus: bonus } });

test('a common voie costs regular points only', () => {
  assert.deepEqual(facettePayment(augustin(undefined), 76, 1), { regular: 1, customData: null });
});

test('a regular point in calme grants a free point in mage', () => {
  const { regular, customData } = facettePayment(augustin(undefined), 80, 1);
  assert.equal(regular, 1);
  assert.deepEqual(customData.facette_bonus, { calme: 0, mage: 1 });
  assert.equal(customData.threshold_percent, 60);
});

test('a rang 3 (2 points) in calme grants 2 free points in mage', () => {
  assert.deepEqual(facettePayment(augustin(undefined), 78, 2).customData.facette_bonus, { calme: 0, mage: 2 });
});

test('free points are spent first and grant nothing', () => {
  const { regular, customData } = facettePayment(augustin({ calme: 0, mage: 2 }), 82, 1);
  assert.equal(regular, 0);
  assert.deepEqual(customData.facette_bonus, { calme: 0, mage: 1 });
});

test('a rang costing more than the free points mixes both, the regular part grants', () => {
  const { regular, customData } = facettePayment(augustin({ calme: 0, mage: 1 }), 83, 2);
  assert.equal(regular, 1);
  assert.deepEqual(customData.facette_bonus, { calme: 1, mage: 0 });
});

test('characters without facettes are untouched', () => {
  assert.deepEqual(facettePayment({ custom_data: {} }, 78, 2), { regular: 2, customData: null });
});
