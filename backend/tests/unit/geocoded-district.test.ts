/**
 * Reverse geocoding → address fields: a revenue DIVISION reported where the
 * district should be ("Udaipur Division" for Kuraj, Rajsamand district) is
 * never shown as the district.
 */

import { describe, expect, it } from 'vitest';
import { suggestionFromPlace } from '../../src/shared/location';

describe('suggestionFromPlace — district', () => {
  it('drops a division reported as the district instead of showing it', () => {
    const s = suggestionFromPlace({ city: 'Kuraj', subregion: 'Udaipur Division', region: 'Rajasthan', postalCode: '313328' });
    expect(s).toMatchObject({ city: 'Kuraj', district: null, state: 'Rajasthan', pincode: '313328' });
  });

  it('keeps a real district', () => {
    expect(suggestionFromPlace({ city: 'Railmagra', subregion: 'Rajsamand', region: 'Rajasthan' })?.district).toBe('Rajsamand');
  });
});
