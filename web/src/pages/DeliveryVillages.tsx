/**
 * Configuration → Approved Delivery Villages (DELIVERY_LOCATIONS).
 *
 * The list of places Aadione delivers to: each village / town / city with
 * ITS PIN code — stored as pairs, never as two separate lists. The admin can
 * add pairs, edit them, switch each one on or off, and delete them; changes
 * are made in the table and saved together ("Save changes"), validated by
 * the server (PATCH /admin/config, CONFIG_WRITE).
 *
 * The server decides delivery from this list for every saved address,
 * checkout and order (backend addresses/delivery-locations.ts): the exact
 * village with its own PIN, active. The app's address dropdowns show only the
 * active pairs. The service location and radius above stay as they are: they
 * measure the distance for the delivery fee and time.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfigKey, Permission, roleHasPermission, type DeliveryLocationPair } from '@shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button, ErrorBanner, Field, Panel, Toggle, inputClass } from '@/components/ui';

const PIN_PATTERN = /^[1-9][0-9]{5}$/;

const normalize = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const clean = (name: string) => name.trim().replace(/\s+/g, ' ');
const newId = () => `loc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Why a village + PIN cannot be added / saved as it is (null: fine). */
export function pairProblem(list: readonly DeliveryLocationPair[], village: string, pincode: string, exceptId?: string): string | null {
  const name = clean(village);
  if (name.length < 2 || name.length > 80) return 'Enter the village / town / city (2 to 80 characters).';
  if (!PIN_PATTERN.test(pincode.trim())) return 'Enter a 6-digit PIN code, such as 313328.';
  if (list.some((p) => p.id !== exceptId && normalize(p.village) === normalize(name) && p.pincode === pincode.trim())) {
    return `${name} with PIN ${pincode.trim()} is already in the list.`;
  }
  return null;
}

export default function DeliveryVillages({ saved }: { saved: DeliveryLocationPair[] }) {
  const role = useAuth((state) => state.user?.role);
  const canWrite = role !== undefined && roleHasPermission(role, Permission.CONFIG_WRITE);
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<DeliveryLocationPair[]>(saved);
  const [village, setVillage] = useState('');
  const [pincode, setPincode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; village: string; pincode: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The server's list after a save (or a reload) becomes the new starting point.
  useEffect(() => setDraft(saved), [saved]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const activeCount = draft.filter((p) => p.active).length;

  const save = useMutation({
    mutationFn: (value: DeliveryLocationPair[]) => api.patch('/admin/config', { key: ConfigKey.DELIVERY_LOCATIONS, value }),
    onSuccess: () => {
      setNotice('Approved delivery villages saved. The app and checkout use them right away.');
      void queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });

  function add(): void {
    setNotice(null);
    const why = pairProblem(draft, village, pincode);
    if (why) return setProblem(why);
    setProblem(null);
    setDraft([...draft, { id: newId(), village: clean(village), pincode: pincode.trim(), active: true }]);
    setVillage('');
    setPincode('');
  }

  function commitEdit(): void {
    if (!editing) return;
    const why = pairProblem(draft, editing.village, editing.pincode, editing.id);
    if (why) return setProblem(why);
    setProblem(null);
    setDraft(draft.map((p) => (p.id === editing.id ? { ...p, village: clean(editing.village), pincode: editing.pincode.trim() } : p)));
    setEditing(null);
  }

  function remove(pair: DeliveryLocationPair): void {
    if (!window.confirm(`Remove ${pair.village} (${pair.pincode}) from the approved list? Addresses there will no longer be delivered to once you save.`)) return;
    setDraft(draft.filter((p) => p.id !== pair.id));
  }

  const sorted = [...draft].sort((a, b) => a.village.localeCompare(b.village) || a.pincode.localeCompare(b.pincode));

  return (
    <div id="delivery-villages" className="scroll-mt-24">
      <Panel title="Approved Delivery Villages & PIN Codes">
        <div className="space-y-4 text-sm">
          <p className="rounded-xl bg-info-50 px-3.5 py-2.5 text-gray-700">
            Aadione delivers only to the villages / towns below, each with its own PIN code. A customer&apos;s address must match an{' '}
            <span className="font-semibold">active</span> village and its PIN exactly — the app offers only these, and checkout refuses anything else. The
            service location and delivery radius above are still used to work out the delivery fee and delivery time.
          </p>
          {activeCount === 0 && (
            <p role="alert" className="rounded-xl bg-danger-50 px-3.5 py-2.5 font-medium text-danger-700">
              No active village — customers cannot save an address or place an order until you add (and save) at least one.
            </p>
          )}

          {canWrite && (
            <form
              className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                add();
              }}
            >
              <Field label="Village / Town / City" required>
                <input value={village} maxLength={80} onChange={(e) => setVillage(e.target.value)} className={inputClass} placeholder="e.g. Kuraj" />
              </Field>
              <Field label="PIN Code" required>
                <input
                  value={pincode}
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(e) => setPincode(e.target.value.replace(/\D/g, ''))}
                  className={inputClass}
                  placeholder="313328"
                />
              </Field>
              <Button type="submit" variant="secondary">
                Add
              </Button>
            </form>
          )}
          <ErrorBanner message={problem} />

          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Village / Town / City</th>
                  <th className="px-3 py-2">PIN Code</th>
                  <th className="px-3 py-2">Status</th>
                  {canWrite && <th className="px-3 py-2 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center text-gray-500">
                      No villages yet.
                    </td>
                  </tr>
                )}
                {sorted.map((pair) =>
                  editing?.id === pair.id ? (
                    <tr key={pair.id} className="bg-brand-50/40">
                      <td className="px-3 py-2">
                        <input
                          value={editing.village}
                          maxLength={80}
                          onChange={(e) => setEditing({ ...editing, village: e.target.value })}
                          className={inputClass}
                          aria-label="Village / town / city"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={editing.pincode}
                          maxLength={6}
                          inputMode="numeric"
                          onChange={(e) => setEditing({ ...editing, pincode: e.target.value.replace(/\D/g, '') })}
                          className={inputClass}
                          aria-label="PIN code"
                        />
                      </td>
                      <td className="px-3 py-2 text-gray-500">{pair.active ? 'Active' : 'Disabled'}</td>
                      <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                        <Button variant="soft" onClick={commitEdit}>
                          Done
                        </Button>
                        <Button variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={pair.id}>
                      <td className="px-3 py-2 font-medium text-gray-900">{pair.village}</td>
                      <td className="px-3 py-2 tabular-nums">{pair.pincode}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-2">
                          <Toggle
                            checked={pair.active}
                            disabled={!canWrite}
                            label={`${pair.village} ${pair.pincode} ${pair.active ? 'active' : 'disabled'}`}
                            onChange={(next) => setDraft(draft.map((p) => (p.id === pair.id ? { ...p, active: next } : p)))}
                          />
                          <span className={pair.active ? 'text-brand-700' : 'text-gray-500'}>{pair.active ? 'Active' : 'Disabled'}</span>
                        </span>
                      </td>
                      {canWrite && (
                        <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                          <Button variant="ghost" onClick={() => setEditing({ id: pair.id, village: pair.village, pincode: pair.pincode })}>
                            Edit
                          </Button>
                          <Button variant="ghost" onClick={() => remove(pair)}>
                            Delete
                          </Button>
                        </td>
                      )}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>

          {canWrite && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  setNotice(null);
                  save.mutate(draft);
                }}
                disabled={!dirty || save.isPending || editing !== null}
              >
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(saved)} disabled={!dirty || save.isPending}>
                Discard changes
              </Button>
              {dirty && <span className="text-xs text-warn-700">Unsaved changes</span>}
            </div>
          )}
          <ErrorBanner message={save.isError ? (save.error instanceof Error ? save.error.message : 'Could not save the villages.') : null} />
          {notice && <p className="text-brand-700">{notice}</p>}
        </div>
      </Panel>
    </div>
  );
}
