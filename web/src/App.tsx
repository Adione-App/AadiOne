import { useEffect, useState } from 'react';
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from 'react-router-dom';
import { Permission, roleHasPermission } from '@shared';
import { useAuth } from '@/lib/auth';
import { onSessionExpired } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';
import { Icon, Spinner, type IconName } from '@/components/ui';
import { NotificationBell } from '@/components/NotificationBell';
import { useAdminNotificationSource } from '@/lib/notifications';
import { todayIsoInIndia } from '@/lib/dashboardDate';
import LoginPage from '@/pages/Login';
import DashboardPage from '@/pages/Dashboard';
import OrdersPage from '@/pages/Orders';
import ProductsPage from '@/pages/Products';
import ProductApprovalsPage from '@/pages/ProductApprovals';
import SellersPage from '@/pages/Sellers';
import SellerDetailPage from '@/pages/SellerDetail';
import { usePendingApprovalCount } from '@/lib/productApprovals';
import CategoriesPage from '@/pages/Categories';
import InventoryPage from '@/pages/Inventory';
import CustomersPage from '@/pages/Customers';
import DeliveryPage from '@/pages/Delivery';
import ReferralsPage from '@/pages/Referrals';
import ConfigPage from '@/pages/Config';
import PaymentsPage from '@/pages/Payments';
import RefundsPage from '@/pages/Refunds';
import CommissionPage from '@/pages/Commission';
import SettlementsPage from '@/pages/Settlements';
import NotificationsPage from '@/pages/Notifications';
import AuditLogsPage from '@/pages/AuditLogs';
import { AadioneWordmark } from '@/components/PartnerLogin';
import SellerApp from '@/seller/SellerApp';

type NavSection = 'MAIN' | 'MARKETPLACE' | 'USERS' | 'FINANCE' | 'GROWTH' | 'SYSTEM';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  section: NavSection;
  end?: boolean;
  /** Page heading and sub-heading shown in the top bar. */
  title: string;
  subtitle: string;
  /** A live count shown beside the label. */
  badge?: 'pendingApprovals';
  /** Shown only to roles holding this permission (display only — the API
   * enforces it). Items without one are shown to every admin, as before. */
  permission?: Permission;
}

const SECTIONS: { key: NavSection; label: string }[] = [
  { key: 'MAIN', label: 'Main' },
  { key: 'MARKETPLACE', label: 'Marketplace' },
  { key: 'USERS', label: 'Users' },
  { key: 'FINANCE', label: 'Finance' },
  { key: 'GROWTH', label: 'Growth' },
  { key: 'SYSTEM', label: 'System' },
];

/**
 * The Marketplace Admin. Aadione is one seller among the others (Sellers);
 * every seller creates its own categories and products in the Seller Panel,
 * so admin Products / Categories are monitoring views (plus moderation).
 */
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', section: 'MAIN', end: true, title: 'Dashboard', subtitle: 'Marketplace overview' },
  { to: '/orders', label: 'Orders', icon: 'orders', section: 'MAIN', title: 'Orders', subtitle: 'Customer orders across every seller' },
  {
    to: '/payments',
    label: 'Payments',
    icon: 'rupee',
    section: 'MAIN',
    title: 'Payments',
    subtitle: 'Cashfree payments for every order',
    permission: Permission.ORDER_REFUND,
  },
  {
    to: '/refunds',
    label: 'Refunds',
    icon: 'rupee',
    section: 'MAIN',
    title: 'Refunds',
    subtitle: 'Refunds sent back through Cashfree',
    permission: Permission.ORDER_REFUND,
  },
  { to: '/delivery', label: 'Delivery', icon: 'delivery', section: 'MAIN', title: 'Delivery', subtitle: 'Agents, assignments and cash settlement' },
  {
    to: '/sellers',
    label: 'Sellers',
    icon: 'store',
    section: 'MARKETPLACE',
    title: 'Sellers',
    subtitle: 'Every seller on the marketplace — Aadione included',
    permission: Permission.SELLER_ONBOARDING_REVIEW,
  },
  { to: '/products', label: 'Products', icon: 'products', section: 'MARKETPLACE', title: 'Products', subtitle: 'Marketplace catalogue — monitoring and moderation' },
  {
    to: '/product-approvals',
    label: 'Product Approvals',
    icon: 'shield',
    section: 'MARKETPLACE',
    title: 'Product Approvals',
    subtitle: 'Review products submitted by sellers',
    badge: 'pendingApprovals',
  },
  {
    to: '/categories',
    label: 'Categories',
    icon: 'categories',
    section: 'MARKETPLACE',
    title: 'Marketplace Catalogue',
    subtitle: 'Browse categories, subcategories and products across all sellers.',
  },
  { to: '/inventory', label: 'Inventory', icon: 'inventory', section: 'MARKETPLACE', title: 'Inventory', subtitle: 'Stock across every seller' },
  { to: '/customers', label: 'Customers', icon: 'customers', section: 'USERS', title: 'Customers', subtitle: 'People who order on Aadione' },
  {
    to: '/commission',
    label: 'Commission',
    icon: 'barChart',
    section: 'FINANCE',
    title: 'Commission',
    subtitle: 'Commission rules and earnings by seller',
    permission: Permission.COMMISSION_MANAGE,
  },
  {
    to: '/settlements',
    label: 'Settlements',
    icon: 'clipboard',
    section: 'FINANCE',
    title: 'Settlements',
    subtitle: 'Seller payouts',
    permission: Permission.SETTLEMENT_READ,
  },
  { to: '/referrals', label: 'Referrals', icon: 'gift', section: 'GROWTH', title: 'Referrals', subtitle: 'Refer & Earn activity and rewards issued' },
  { to: '/notifications', label: 'Notifications', icon: 'bell', section: 'SYSTEM', title: 'Notifications', subtitle: 'Platform operational notifications' },
  {
    to: '/audit-logs',
    label: 'Audit Logs',
    icon: 'shield',
    section: 'SYSTEM',
    title: 'Audit Logs',
    subtitle: 'Who changed what, and when',
    permission: Permission.CONFIG_WRITE,
  },
  { to: '/settings', label: 'Configuration', icon: 'config', section: 'SYSTEM', title: 'Configuration', subtitle: 'Platform settings' },
];

/**
 * Sidebar summary. The badge reports the real trading state rather than a
 * decorative "Open": the whole point of the switch on the Configuration page
 * is that someone can see, from any screen, whether the app is taking orders.
 */
/** Products awaiting review — fetched once, refreshed after each decision. */
function PendingApprovalsBadge() {
  const pending = usePendingApprovalCount();
  if (!pending.data || pending.data.count === 0) return null;
  const { count, more } = pending.data;
  return (
    <span
      aria-label={`${count} awaiting review`}
      className="ml-auto rounded-full bg-warn-50 px-2 py-0.5 text-xs font-semibold text-warn-500"
    >
      {more ? `${count}+` : count}
    </span>
  );
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const role = useAuth((state) => state.user?.role);
  const items = NAV.filter((item) => !item.permission || (role !== undefined && roleHasPermission(role, item.permission)));

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="px-6 py-5">
        <AadioneWordmark className="text-2xl" />
        <p className="mt-1 text-xs font-medium text-gray-500">Marketplace Admin</p>
      </div>

      <nav aria-label="Admin" className="flex-1 space-y-4 overflow-y-auto px-3 pb-3">
        {SECTIONS.map((section) => {
          const sectionItems = items.filter((item) => item.section === section.key);
          if (sectionItems.length === 0) return null;
          return (
            <div key={section.key}>
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{section.label}</p>
              <div className="space-y-0.5">
                {sectionItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-brand-400 ${
                        isActive ? 'bg-brand-50 text-brand-600' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                      }`
                    }
                  >
                    <Icon name={item.icon} />
                    {item.label}
                    {item.badge === 'pendingApprovals' && <PendingApprovalsBadge />}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

    </div>
  );
}

/** Dashboard lives at "/" — only there does the date pill become a picker. */
const DASHBOARD_PATH = '/';

function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const user = useAuth((state) => state.user);
  const logout = useAuth((state) => state.logout);
  const [menuOpen, setMenuOpen] = useState(false);
  const notificationSource = useAdminNotificationSource();

  // Longest matching prefix, so /products/new still reads as "Products".
  const active =
    NAV.filter((item) => (item.end ? pathname === item.to : pathname.startsWith(item.to))).sort(
      (a, b) => b.to.length - a.to.length,
    )[0] ?? NAV[0]!;

  const isDashboard = pathname === DASHBOARD_PATH;
  const todayIso = todayIsoInIndia();
  const selectedDate = searchParams.get('date') ?? todayIso;

  const today = new Date().toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <header className="sticky top-0 z-30 border-b border-gray-200 bg-white">
      <div className="flex items-center gap-4 px-4 py-3.5 sm:px-6">
        <button
          onClick={onOpenNav}
          aria-label="Open navigation"
          className="rounded-lg p-2 text-gray-500 transition hover:bg-gray-100 lg:hidden"
        >
          <Icon name="menu" />
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold text-gray-900">{active.title}</h1>
          <p className="truncate text-sm text-gray-500">{active.subtitle}</p>
        </div>

        {isDashboard ? (
          <label
            className="hidden cursor-pointer items-center gap-2 rounded-xl border border-gray-300 px-3.5 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 md:flex"
            title="View the dashboard for a different date"
          >
            <Icon name="calendar" className="h-4 w-4 text-gray-400" />
            <input
              type="date"
              value={selectedDate}
              max={todayIso}
              onChange={(event) => {
                const value = event.target.value;
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  // Future dates can't reach here (disabled by `max`), but a
                  // date >= today is treated as "today" either way — that's
                  // the default, so drop the param and keep the URL clean.
                  if (!value || value >= todayIso) next.delete('date');
                  else next.set('date', value);
                  return next;
                });
              }}
              className="cursor-pointer border-none bg-transparent p-0 text-sm font-medium text-gray-700 outline-none"
            />
          </label>
        ) : (
          <div className="hidden items-center gap-2 rounded-xl border border-gray-300 px-3.5 py-2.5 text-sm font-medium text-gray-700 md:flex">
            <Icon name="calendar" className="h-4 w-4 text-gray-400" />
            {today}
          </div>
        )}

        <NotificationBell source={notificationSource} />

        <div className="relative">
          <button
            onClick={() => setMenuOpen((open) => !open)}
            className="flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 transition hover:bg-gray-100"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-100 text-gray-500">
              <Icon name="user" className="h-5 w-5" />
            </span>
            <span className="hidden text-left sm:block">
              <span className="block text-sm font-semibold leading-tight text-gray-900">
                {user?.fullName ?? 'Marketplace Admin'}
              </span>
              <span className="block text-xs leading-tight text-gray-500">
                {user?.email ?? 'Aadione'}
              </span>
            </span>
            <Icon name="chevronDown" className="hidden h-4 w-4 text-gray-400 sm:block" />
          </button>

          {menuOpen && (
            <>
              <button
                className="fixed inset-0 z-10 cursor-default"
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
                <button
                  onClick={() => {
                    disconnectSocket();
                    void logout();
                  }}
                  className="block w-full px-4 py-2.5 text-left text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Permanent rail from lg up; slide-over below it, because the counter
          tablet is often held in portrait. */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-gray-200 lg:block">
        <Sidebar onNavigate={() => undefined} />
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-gray-900/40"
            onClick={() => setNavOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-gray-200 shadow-xl">
            <Sidebar onNavigate={() => setNavOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <TopBar onOpenNav={() => setNavOpen(true)} />
        <main className="p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

/**
 * Two panels, one bundle: every `/seller` path is the seller panel (its own
 * session, routes and layout — see seller/SellerApp.tsx); everything else is
 * the admin panel, exactly as before.
 */
export default function App() {
  const { pathname } = useLocation();
  if (pathname === '/seller' || pathname.startsWith('/seller/')) return <SellerApp />;
  return <AdminApp />;
}

function AdminApp() {
  const status = useAuth((state) => state.status);
  const restore = useAuth((state) => state.restore);
  const clear = useAuth((state) => state.clear);

  useEffect(() => {
    // A refresh-token rotation failure (or reuse detection server-side) drops
    // the session here rather than leaving the panel showing stale data.
    onSessionExpired(() => {
      disconnectSocket();
      clear();
    });
    void restore();
  }, [restore, clear]);

  if (status === 'loading') return <Spinner label="Restoring session…" />;
  if (status === 'anonymous') return <LoginPage />;

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/product-approvals" element={<ProductApprovalsPage />} />
        <Route path="/sellers" element={<SellersPage />} />
        <Route path="/sellers/:id" element={<SellerDetailPage />} />
        <Route path="/categories" element={<CategoriesPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/delivery" element={<DeliveryPage />} />
        <Route path="/referrals" element={<ReferralsPage />} />
        <Route path="/payments" element={<PaymentsPage />} />
        <Route path="/refunds" element={<RefundsPage />} />
        <Route path="/commission" element={<CommissionPage />} />
        <Route path="/settlements" element={<SettlementsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/audit-logs" element={<AuditLogsPage />} />
        <Route path="/settings" element={<ConfigPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
