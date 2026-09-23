import { useEffect, useState } from 'react';
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { PublicConfig, StoreDto } from '@shared';
import { useAuth } from '@/lib/auth';
import { api, onSessionExpired } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';
import { Icon, Spinner, type IconName } from '@/components/ui';
import { todayIsoInIndia } from '@/lib/dashboardDate';
import LoginPage from '@/pages/Login';
import DashboardPage from '@/pages/Dashboard';
import OrdersPage from '@/pages/Orders';
import ProductsPage from '@/pages/Products';
import CategoriesPage from '@/pages/Categories';
import InventoryPage from '@/pages/Inventory';
import CustomersPage from '@/pages/Customers';
import DeliveryPage from '@/pages/Delivery';
import ReferralsPage from '@/pages/Referrals';
import ConfigPage from '@/pages/Config';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  /** Page heading and sub-heading shown in the top bar. */
  title: string;
  subtitle: string;
}

const NAV: NavItem[] = [
  {
    to: '/',
    label: 'Dashboard',
    icon: 'dashboard',
    end: true,
    title: 'Dashboard',
    subtitle: 'Overview of your store',
  },
  {
    to: '/orders',
    label: 'Orders',
    icon: 'orders',
    title: 'Orders',
    subtitle: 'Manage and track all customer orders',
  },
  {
    to: '/products',
    label: 'Products',
    icon: 'products',
    title: 'Products',
    subtitle: 'Manage all store products',
  },
  {
    to: '/categories',
    label: 'Categories',
    icon: 'categories',
    title: 'Categories',
    subtitle: 'Organise how products are browsed',
  },
  {
    to: '/inventory',
    label: 'Inventory',
    icon: 'inventory',
    title: 'Inventory',
    subtitle: 'Track stock levels and manage inventory',
  },
  {
    to: '/customers',
    label: 'Customers',
    icon: 'customers',
    title: 'Customers',
    subtitle: 'People who order from your store',
  },
  {
    to: '/delivery',
    label: 'Delivery',
    icon: 'delivery',
    title: 'Delivery',
    subtitle: 'Agents, assignments and cash settlement',
  },
  {
    to: '/referrals',
    label: 'Referrals',
    icon: 'gift',
    title: 'Referrals',
    subtitle: 'Refer & Earn activity and rewards issued',
  },
  {
    to: '/settings',
    label: 'Configuration',
    icon: 'config',
    title: 'Configuration',
    subtitle: 'Store hours, fees and serviceability',
  },
];

/**
 * Sidebar summary. The badge reports the real trading state rather than a
 * decorative "Open": the whole point of the switch on the Configuration page
 * is that someone can see, from any screen, whether the app is taking orders.
 */
function StoreCard() {
  const config = useQuery({
    queryKey: ['public-config'],
    queryFn: () => api.get<PublicConfig>('/config/public'),
    staleTime: 5 * 60_000,
  });

  const store = useQuery({
    queryKey: ['store'],
    queryFn: () => api.get<StoreDto>('/store'),
    // A shop switched off at the counter should go grey here within the minute,
    // not whenever the panel happens to be reloaded.
    refetchInterval: 60_000,
  });

  const radiusKm = config.data?.MAX_SERVICE_RADIUS_KM;

  const status = !store.data
    ? { label: '—', className: 'bg-gray-100 text-gray-500' }
    : !store.data.isActive
      ? { label: 'Switched off', className: 'bg-danger-50 text-danger-500' }
      : store.data.isOpenNow
        ? { label: 'Open', className: 'bg-brand-50 text-brand-600' }
        : { label: 'Closed', className: 'bg-warn-50 text-warn-500' };

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <Icon name="store" />
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-gray-900">
          {store.data?.name ?? 'AdiOne Store'}
        </p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${status.className}`}>
          {status.label}
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Service Radius: {radiusKm != null ? `${radiusKm} km` : '—'}
      </p>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="px-6 py-6">
        <p className="text-2xl font-bold leading-none">
          <span className="text-gray-900">Adi</span>
          <span className="text-brand-500">One</span>
        </p>
        <p className="mt-1 text-xs font-medium text-gray-500">Admin Panel</p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                isActive
                  ? 'bg-brand-50 text-brand-600'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`
            }
          >
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="p-3">
        <StoreCard />
      </div>
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

        <NavLink
          to="/orders"
          aria-label="Notifications"
          className="rounded-lg p-2.5 text-gray-500 transition hover:bg-gray-100"
        >
          <Icon name="bell" />
        </NavLink>

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
                {user?.fullName ?? 'Store Admin'}
              </span>
              <span className="block text-xs leading-tight text-gray-500">
                {user?.email ?? 'Store Manager'}
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

export default function App() {
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
        <Route path="/categories" element={<CategoriesPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/delivery" element={<DeliveryPage />} />
        <Route path="/referrals" element={<ReferralsPage />} />
        <Route path="/settings" element={<ConfigPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
