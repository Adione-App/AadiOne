import { describe, expect, it } from 'vitest';
import { brandDisplayName, brandKey, brandProblem, brandSlug } from '../../src/modules/product-import/brand';

describe('bulk import brand names', () => {
  it('normalises capitals and whitespace to one key and one slug', () => {
    const spellings = ['Bikaji', 'BIKAJI', 'bikaji', '  bikaji ', 'Bi kaji'.replace(' ', '')];
    expect(new Set(spellings.map(brandKey))).toEqual(new Set(['bikaji']));
    expect(new Set(spellings.map(brandSlug))).toEqual(new Set(['bikaji']));
    expect(brandDisplayName('  Desi   Swad\t')).toBe('Desi Swad');
    expect(brandKey('Desi  SWAD')).toBe(brandKey('desi swad'));
  });

  it('gives names without Latin letters a stable slug of their own', () => {
    expect(brandSlug('बीकाजी')).toMatch(/^brand-[0-9a-f]{12}$/);
    expect(brandSlug('बीकाजी')).toBe(brandSlug('  बीकाजी '));
    expect(brandSlug('बीकाजी')).not.toBe(brandSlug('हल्दीराम'));
    expect(brandSlug("Haldiram's")).toBe('haldirams');
    expect(brandSlug('Haldiram’s')).toBe(brandSlug('Haldirams'));
  });

  it('refuses names that cannot be stored or matched', () => {
    expect(brandProblem('Bikaji')).toBeNull();
    expect(brandProblem('बीकाजी')).toBeNull();
    expect(brandProblem('X'.repeat(121))).toMatch(/at most 120/);
    expect(brandProblem('!!! ---')).toMatch(/letters or numbers/);
  });
});
