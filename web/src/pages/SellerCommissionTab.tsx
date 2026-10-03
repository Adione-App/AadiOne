/**
 * Seller detail — Commission tab.
 *
 * Existing admin APIs only (every one requires COMMISSION_MANAGE):
 *   GET    /admin/sellers/:id/commission                       default + ACTIVE rules
 *   GET    /admin/sellers/:id/commission/history               every rule row (not paginated)
 *   PUT    /admin/sellers/:id/commission/default               { rateBp }
 *   PUT    /admin/sellers/:id/commission/{categories|products}/:targetId   { rateBp }
 *   DELETE /admin/sellers/:id/commission/{categories|products}/:targetId
 *
 * The backend resolves each order line once, at order time: PRODUCT rule ->
 * exact CATEGORY rule -> seller default. Nothing here calculates commission;
 * it only shows and edits the backend's rules. Rates are integer basis points
 * on the wire (0–10 000) and whole-percent text in the UI.
 *
 * The seller default is a required value with no remove endpoint (0% = no
 * default commission). Rules target products/categories the seller actually
 * lists (from GET /admin/sellers/:id/listings). Every seller — Aadione
 * included — is edited the same way.
 */

import { useMemo, useState, type FormEvent } from 'react';
import type { AdminSellerDetailDto } from '@shared';
import {
  COMMISSION_BP_MAX,
  formatCommissionBp,
  percentToBp,
  sellerErrorMessage,
  useAdminSellerCommission,
  useAdminSellerCommissionHistory,
  useAdminSellerListings,
  useRemoveCommissionRule,
  useSetCommissionRule,
  useSetDefaultCommission,
  type AdminCommissionConfig,
  type CommissionRuleScope,
} from '@/lib/sellers';
import { formatSellerDate } from '@/components/SellerBadges';
import { Button, EmptyState, ErrorBanner, Field, Icon, Modal, Panel, Pill, Spinner, Td, Th, inputClass } from '@/components/ui';

const SCOPE_LABEL: Record<CommissionRuleScope, { one: string; title: string }> = {
  products: { one: 'product', title: 'Product rules' },
  categories: { one: 'category', title: 'Category rules' },
};

const shortId = (id: string) => id.slice(0, 8).toUpperCase();

type RuleRow = { scope: CommissionRuleScope; targetId: string; name: string | null; rateBp: number; since: string };
type RuleModalState =
  | { mode: 'default' }
  | { mode: 'add'; scope: CommissionRuleScope }
  | { mode: 'edit'; rule: RuleRow }
  | { mode: 'remove'; rule: RuleRow };

export default function SellerCommissionTab({
  seller,
  canWrite,
  onNotice,
}: {
  seller: AdminSellerDetailDto;
  /** COMMISSION_MANAGE held (the parent only mounts this tab when it is). */
  canWrite: boolean;
  onNotice: (message: string) => void;
}) {
  const config = useAdminSellerCommission(seller.id);
  const history = useAdminSellerCommissionHistory(seller.id);
  const listings = useAdminSellerListings(seller.id, canWrite);
  const [modal, setModal] = useState<RuleModalState | null>(null);
  const editable = canWrite;

  /** Names for history rows: active rules first, then the seller's listings. */
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const listing of listings.data ?? []) {
      map.set(listing.productId, listing.productName);
      map.set(listing.categoryId, listing.categoryName);
    }
    for (const rule of config.data?.productRules ?? []) if (rule.productName) map.set(rule.productId, rule.productName);
    for (const rule of config.data?.categoryRules ?? []) if (rule.categoryName) map.set(rule.categoryId, rule.categoryName);
    return map;
  }, [config.data, listings.data]);

  if (config.isPending) return <Spinner label="Loading commission…" />;
  if (config.isError) {
    return (
      <div className="space-y-3">
        <ErrorBanner message={sellerErrorMessage(config.error, 'Could not load commission.')} />
        <Button variant="secondary" onClick={() => void config.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const c = config.data;
  const rules: Record<CommissionRuleScope, RuleRow[]> = {
    products: c.productRules.map((r) => ({ scope: 'products', targetId: r.productId, name: r.productName, rateBp: r.rateBp, since: r.since })),
    categories: c.categoryRules.map((r) => ({ scope: 'categories', targetId: r.categoryId, name: r.categoryName, rateBp: r.rateBp, since: r.since })),
  };

  return (
    <div className="space-y-5">
      <p className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-600">
        Product-specific commission overrides category commission, which overrides the seller default. A category rule
        applies to that exact category only. Changes apply to new orders; past orders keep the rate they were placed at.
      </p>

      <Panel
        title="Seller default"
        action={
          editable && (
            <Button variant="secondary" onClick={() => setModal({ mode: 'default' })}>
              <Icon name="edit" className="h-4 w-4" />
              Edit Commission
            </Button>
          )
        }
      >
        <p className="text-3xl font-bold text-gray-900">{formatCommissionBp(c.defaultCommissionBp)}</p>
        <p className="mt-1 text-sm text-gray-500">
          {c.defaultCommissionBp === 0
            ? 'No default commission — orders without a product or category rule are charged 0%.'
            : 'Charged on order lines that have no product or category rule.'}
        </p>
      </Panel>

      {(['products', 'categories'] as const).map((scope) => (
        <Panel
          key={scope}
          title={SCOPE_LABEL[scope].title}
          bodyClass=""
          action={
            editable && (
              <Button variant="secondary" onClick={() => setModal({ mode: 'add', scope })}>
                <Icon name="plus" className="h-4 w-4" />
                Add {SCOPE_LABEL[scope].one} rule
              </Button>
            )
          }
        >
          {rules[scope].length === 0 ? (
            <div className="p-5 pt-0">
              <EmptyState title={`No ${SCOPE_LABEL[scope].one} rules`} hint={`No ${SCOPE_LABEL[scope].one} overrides the seller default.`} />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-y border-gray-200 bg-gray-50">
                <tr>
                  <Th>{scope === 'products' ? 'Product' : 'Category'}</Th>
                  <Th>Rate</Th>
                  <Th>Since</Th>
                  {editable && <Th className="text-right">Actions</Th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rules[scope].map((rule) => (
                  <tr key={rule.targetId}>
                    <Td className="font-medium text-gray-900">{rule.name ?? `#${shortId(rule.targetId)}`}</Td>
                    <Td>{formatCommissionBp(rule.rateBp)}</Td>
                    <Td className="whitespace-nowrap text-gray-600">{formatSellerDate(rule.since)}</Td>
                    {editable && (
                      <Td>
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" onClick={() => setModal({ mode: 'edit', rule })}>
                            Edit
                          </Button>
                          <Button variant="ghost" onClick={() => setModal({ mode: 'remove', rule })}>
                            Remove
                          </Button>
                        </div>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ))}

      <Panel title="Rule history" bodyClass="">
        <p className="px-5 pb-3 text-xs text-gray-500">
          Every product and category rule, newest first. Seller-default changes are recorded in the audit log, not here.
        </p>
        {history.isPending ? (
          <Spinner label="Loading history…" />
        ) : history.isError ? (
          <div className="space-y-3 p-5 pt-0">
            <ErrorBanner message={sellerErrorMessage(history.error, 'Could not load commission history.')} />
            <Button variant="secondary" onClick={() => void history.refetch()}>
              Try again
            </Button>
          </div>
        ) : history.data.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No commission history" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y border-gray-200 bg-gray-50">
              <tr>
                <Th>Set on</Th>
                <Th>Scope</Th>
                <Th>Target</Th>
                <Th>Rate</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {history.data.map((row) => {
                const target = row.productId ?? row.categoryId ?? '';
                return (
                  <tr key={row.ruleId}>
                    <Td className="whitespace-nowrap text-gray-700">{formatSellerDate(row.createdAt)}</Td>
                    <Td className="text-gray-700">{row.scope === 'PRODUCT' ? 'Product' : 'Category'}</Td>
                    <Td className="font-medium text-gray-900">
                      {names.get(target) ?? (listings.isLoading ? <span className="text-gray-400">…</span> : `#${shortId(target)}`)}
                    </Td>
                    <Td>{formatCommissionBp(row.rateBp)}</Td>
                    <Td>
                      {row.isActive ? (
                        <Pill tone="brand">Active</Pill>
                      ) : (
                        <span className="text-xs text-gray-500">
                          <Pill tone="gray">Ended</Pill> {formatSellerDate(row.updatedAt)}
                        </span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {modal?.mode === 'default' && (
        <RateModal
          title="Edit seller default commission"
          subtitle={seller.name}
          initialBp={c.defaultCommissionBp}
          sellerId={seller.id}
          target={{ kind: 'default' }}
          onClose={() => setModal(null)}
          onDone={(message) => {
            setModal(null);
            onNotice(message);
          }}
        />
      )}
      {(modal?.mode === 'add' || modal?.mode === 'edit') && (
        <RateModal
          title={modal.mode === 'add' ? `Add ${SCOPE_LABEL[modal.scope].one} rule` : `Edit ${SCOPE_LABEL[modal.rule.scope].one} rule`}
          subtitle={modal.mode === 'edit' ? modal.rule.name ?? `#${shortId(modal.rule.targetId)}` : seller.name}
          initialBp={modal.mode === 'edit' ? modal.rule.rateBp : null}
          sellerId={seller.id}
          target={
            modal.mode === 'edit'
              ? { kind: 'rule', scope: modal.rule.scope, targetId: modal.rule.targetId }
              : { kind: 'pick', scope: modal.scope, options: pickOptions(modal.scope, listings.data ?? [], c) }
          }
          optionsLoading={modal.mode === 'add' && listings.isPending}
          onClose={() => setModal(null)}
          onDone={(message) => {
            setModal(null);
            onNotice(message);
          }}
        />
      )}
      {modal?.mode === 'remove' && (
        <RemoveRuleModal
          sellerId={seller.id}
          rule={modal.rule}
          defaultBp={c.defaultCommissionBp}
          onClose={() => setModal(null)}
          onDone={(message) => {
            setModal(null);
            onNotice(message);
          }}
        />
      )}
    </div>
  );
}

/** Products / exact categories this seller lists, not already ruled. */
function pickOptions(
  scope: CommissionRuleScope,
  listings: { productId: string; productName: string; categoryId: string; categoryName: string }[],
  config: AdminCommissionConfig,
): { id: string; name: string }[] {
  const taken = new Set(scope === 'products' ? config.productRules.map((r) => r.productId) : config.categoryRules.map((r) => r.categoryId));
  const seen = new Map<string, string>();
  for (const l of listings) {
    const id = scope === 'products' ? l.productId : l.categoryId;
    if (!taken.has(id) && !seen.has(id)) seen.set(id, scope === 'products' ? l.productName : l.categoryName);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------------- */
/* modals                                                                      */
/* -------------------------------------------------------------------------- */

type RateTarget =
  | { kind: 'default' }
  | { kind: 'rule'; scope: CommissionRuleScope; targetId: string }
  | { kind: 'pick'; scope: CommissionRuleScope; options: { id: string; name: string }[] };

function RateModal({
  title,
  subtitle,
  initialBp,
  sellerId,
  target,
  optionsLoading,
  onClose,
  onDone,
}: {
  title: string;
  subtitle: string;
  initialBp: number | null;
  sellerId: string;
  target: RateTarget;
  optionsLoading?: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const setDefault = useSetDefaultCommission(sellerId);
  const setRule = useSetCommissionRule(sellerId);
  const mutation = target.kind === 'default' ? setDefault : setRule;
  const [percent, setPercent] = useState(initialBp === null ? '' : formatCommissionBp(initialBp).replace('%', ''));
  const [picked, setPicked] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const rateBp = percentToBp(percent);
    if (target.kind === 'pick' && !picked) {
      setError(`Choose a ${SCOPE_LABEL[target.scope].one}.`);
      return;
    }
    if (rateBp === null) {
      setError(`Enter a percentage from 0 to ${COMMISSION_BP_MAX / 100}, with at most two decimals.`);
      return;
    }
    setError(null);
    const done = () => onDone(`Commission set to ${formatCommissionBp(rateBp)}.`);
    if (target.kind === 'default') {
      setDefault.mutate(rateBp, { onSuccess: done });
    } else {
      setRule.mutate({ scope: target.scope, targetId: target.kind === 'rule' ? target.targetId : picked, rateBp }, { onSuccess: done });
    }
  };

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => submit()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save commission'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {mutation.isError && <ErrorBanner message={sellerErrorMessage(mutation.error, 'Could not save the commission.')} />}
        {target.kind === 'pick' && (
          <Field label={target.scope === 'products' ? 'Product' : 'Category'} required>
            {optionsLoading ? (
              <Spinner label="Loading the seller's listings…" />
            ) : target.options.length === 0 ? (
              <p className="text-sm text-gray-500">
                No {SCOPE_LABEL[target.scope].one} without a rule among this seller's listings.
              </p>
            ) : (
              <select value={picked} onChange={(e) => setPicked(e.target.value)} className={inputClass}>
                <option value="">Choose…</option>
                {target.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Commission %" required hint={`0 to ${COMMISSION_BP_MAX / 100}, up to two decimals (e.g. 12.5).`}>
          <input value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="decimal" className={inputClass} />
          {error && <span className="mt-1 block text-xs text-danger-600">{error}</span>}
        </Field>
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

function RemoveRuleModal({
  sellerId,
  rule,
  defaultBp,
  onClose,
  onDone,
}: {
  sellerId: string;
  rule: RuleRow;
  defaultBp: number;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const remove = useRemoveCommissionRule(sellerId);
  const label = rule.name ?? `#${shortId(rule.targetId)}`;
  return (
    <Modal
      title={`Remove ${SCOPE_LABEL[rule.scope].one} rule`}
      subtitle={`${label} · ${formatCommissionBp(rule.rateBp)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate({ scope: rule.scope, targetId: rule.targetId }, { onSuccess: () => onDone(`${label}: commission rule removed.`) })
            }
          >
            {remove.isPending ? 'Removing…' : 'Remove rule'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {remove.isError && <ErrorBanner message={sellerErrorMessage(remove.error, 'Could not remove the rule.')} />}
        <p className="text-sm text-gray-600">
          {rule.scope === 'products'
            ? `New orders of this product fall back to its category rule, or the seller default (${formatCommissionBp(defaultBp)}).`
            : `New orders in this category fall back to the seller default (${formatCommissionBp(defaultBp)}), unless a product has its own rule.`}{' '}
          The rule stays in the history.
        </p>
      </div>
    </Modal>
  );
}
