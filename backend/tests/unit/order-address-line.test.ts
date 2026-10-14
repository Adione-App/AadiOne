/**
 * The order's delivery-address snapshot line (shared/text formatAddressLine):
 * the landmark is phrased once — a landmark saved as "Near Shiv Mandir" used
 * to be snapshotted as "Near Near Shiv Mandir".
 */

import { describe, expect, it } from 'vitest';
import { formatAddressLine } from '../../src/shared/text';

describe('formatAddressLine (order snapshot)', () => {
  it('adds "Near" to a bare landmark', () => {
    expect(formatAddressLine({ area: 'Main Road', landmark: 'Shiv Mandir' })).toBe('Near Shiv Mandir, Main Road');
  });

  it('keeps a landmark that already says where it is', () => {
    expect(formatAddressLine({ area: 'Main Road', landmark: 'Near Shiv Mandir' })).toBe('Near Shiv Mandir, Main Road');
    expect(formatAddressLine({ area: 'Main Road', landmark: 'Opposite the post office' })).toBe('Opposite the post office, Main Road');
  });

  it('leaves out a missing or blank landmark and house details', () => {
    expect(formatAddressLine({ area: 'Main Road', landmark: '  ' })).toBe('Main Road');
    expect(formatAddressLine({ houseNo: null, street: '14, Station Road', area: 'Shastri Nagar' })).toBe('14, Station Road, Shastri Nagar');
    // A live location with no house / locality: nothing is invented.
    expect(formatAddressLine({})).toBe('');
  });
});
