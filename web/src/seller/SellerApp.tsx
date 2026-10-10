/**
 * The seller panel: `/seller/*`, with its own session, routes and layout.
 *
 * Rendered by App.tsx for every `/seller` path INSTEAD of the admin shell, so
 * the two panels never share a session, a layout or a route guard.
 *
 * Navigation is one list (NAV) shown three ways: a sidebar from lg up (which
 * collapses to icons), a slide-over drawer below lg, and a bottom tab bar on
 * phones for the five daily screens.
 *
 * TWO GATES: a signed-in seller only gets this panel once its lifecycle is
 * ACTIVE (GET /seller/lifecycle). Before that — application pending,
 * onboarding, under review, changes required, rejected — every /seller path
 * shows the onboarding/status experience (pages/SellerOnboarding.tsx). The
 * server refuses the operational APIs on its own; this only mirrors it.
 */

import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorBanner, Icon, Spinner, type IconName } from '@/components/ui';
import { NotificationBell } from '@/components/NotificationBell';
import { AadioneWordmark } from '@/components/PartnerLogin';
import { formatUnreadBadge, useNotificationUnreadCount } from '@/lib/notifications';
import { SELLER_QUERY_ROOT, sellerClient, sellerErrorMessage } from './sellerApi';
import { useSellerAuth } from './sellerAuth';
import { useSellerAvailability, useSellerLifecycle, useSellerOrderSummary } from './sellerQueries';
import { isFoodSellerType } from '@shared';
import { useSellerNotificationSource } from './sellerNotifications';
import { ToastRegion } from './sellerUi';
import SellerLoginPage from './pages/SellerLogin';
import SellerRegisterPage from './pages/SellerRegister';
import SellerForgotPasswordPage from './pages/SellerForgotPassword';
import SellerResetPasswordPage from './pages/SellerResetPassword';
import SellerOnboardingPage from './pages/SellerOnboarding';
import SellerDashboardPage from './pages/SellerDashboard';
import SellerOrdersPage from './pages/SellerOrders';
import SellerProductsPage from './pages/SellerProducts';
import SellerInventoryPage from './pages/SellerInventory';
import SellerAvailabilityPage from './pages/SellerAvailability';
import SellerProfilePage from './pages/SellerProfile';
import SellerEarningsPage from './pages/SellerEarnings';
import SellerSettlementsPage from './pages/SellerSettlements';
import SellerNotificationsPage from './pages/SellerNotifications';
import SellerCategoriesPage from './pages/SellerCategories';
import SellerProductDetailPage from './pages/SellerProductDetail';
import SellerListingDetailPage from './pages/SellerListingDetail';
import SellerBulkImportPage from './pages/SellerBulkImport';
import SellerImportHistoryPage from './pages/SellerImportHistory';

type Badge = 'orders' | 'notifications';

type SellerNavSection = 'MAIN' | 'FINANCE' | 'COMMUNICATION' | 'BUSINESS';

const SECTIONS: { key: SellerNavSection; label: string }[] = [
  { key: 'MAIN', label: 'Main' },
  { key: 'FINANCE', label: 'Finance' },
  { key: 'COMMUNICATION', label: 'Communication' },
  { key: 'BUSINESS', label: 'Business' },
];

/**
 * `section: null` pages (none at the moment) would be reached from inside another
 * page — not listed in the sidebar, but they still name the header.
 * Restaurant details live inside Profile.
 */
const NAV: { to: string; label: string; icon: IconName; section: SellerNavSection | null; end?: boolean; badge?: Badge }[] = [
  { to: '/seller', label: 'Dashboard', icon: 'dashboard', section: 'MAIN', end: true },
  { to: '/seller/orders', label: 'Orders', icon: 'orders', section: 'MAIN', badge: 'orders' },
  { to: '/seller/products', label: 'Products', icon: 'products', section: 'MAIN' },
  { to: '/seller/categories', label: 'Categories', icon: 'categories', section: 'MAIN' },
  { to: '/seller/inventory', label: 'Inventory', icon: 'inventory', section: 'MAIN' },
  { to: '/seller/availability', label: 'Availability', icon: 'clock', section: 'MAIN' },
  { to: '/seller/earnings', label: 'Earnings', icon: 'rupee', section: 'FINANCE' },
  { to: '/seller/settlements', label: 'Settlements', icon: 'clipboard', section: 'FINANCE' },
  { to: '/seller/notifications', label: 'Notifications', icon: 'bell', section: 'COMMUNICATION', badge: 'notifications' },
  { to: '/seller/profile', label: 'Profile', icon: 'user', section: 'BUSINESS' },
];

/**
 * NAV for this seller: a restaurant / cafe manages its MENU (Menu → Menu
 * Section → Food Item) on the Categories page, so that entry reads "Menu",
 * and has no stock to manage, so Inventory is left out.
 */
function useNav(): typeof NAV {
  const isFood = isFoodSellerType(useSellerAvailability().data?.sellerType);
  if (!isFood) return NAV;
  // Food items are made to order — no stock to manage, so no Inventory page.
  return NAV.filter((item) => item.to !== '/seller/inventory').map((item) => (item.to === '/seller/categories' ? { ...item, label: 'Menu' } : item));
}

/** Phone tab bar: the daily screens; everything else is under More. */
const TABS: { to: string; label: string; icon: IconName; end?: boolean; badge?: Badge }[] = [
  { to: '/seller', label: 'Home', icon: 'dashboard', end: true },
  { to: '/seller/orders', label: 'Orders', icon: 'orders', badge: 'orders' },
  { to: '/seller/products', label: 'Products', icon: 'products' },
  { to: '/seller/inventory', label: 'Inventory', icon: 'inventory' },
];

const COLLAPSE_KEY = 'aadione.seller.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
  } catch {
    // Storage blocked (private window): the choice just isn't remembered.
  }
}

export default function SellerApp() {
  const status = useSellerAuth((state) => state.status);
  const restore = useSellerAuth((state) => state.restore);
  const clear = useSellerAuth((state) => state.clear);
  const queryClient = useQueryClient();

  useEffect(() => {
    // A refresh failure mid-session (expired or revoked) drops to the login
    // page instead of leaving the panel showing stale data.
    sellerClient.onSessionExpired(clear);
    void restore();
  }, [restore, clear]);

  // Nothing of a previous seller's data survives a sign-out.
  useEffect(() => {
    if (status === 'anonymous') queryClient.removeQueries({ queryKey: [SELLER_QUERY_ROOT] });
  }, [status, queryClient]);

  if (status === 'loading') return <Spinner label="Restoring session…" />;

  if (status !== 'authenticated') {
    return (
      <Routes>
        <Route path="/seller/login" element={<SellerLoginPage />} />
        <Route path="/seller/register" element={<SellerRegisterPage />} />
        <Route path="/seller/forgot-password" element={<SellerForgotPasswordPage />} />
        <Route path="/seller/reset-password" element={<SellerResetPasswordPage />} />
        <Route path="*" element={<Navigate to="/seller/login" replace />} />
      </Routes>
    );
  }

  return <AuthenticatedSellerApp />;
}

/**
 * Signed in: the lifecycle decides between the onboarding/status screens and
 * the full Seller Panel.
 */
function AuthenticatedSellerApp() {
  const lifecycle = useSellerLifecycle();
  const logout = useSellerAuth((state) => state.logout);

  if (lifecycle.isPending) return <Spinner label="Opening your seller account…" />;
  if (lifecycle.isError) {
    return (
      <div className="mx-auto max-w-md space-y-3 p-6">
        <ErrorBanner message={sellerErrorMessage(lifecycle.error)} />
        <div className="flex gap-2">
          <button type="button" onClick={() => void lifecycle.refetch()} className="rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white">
            Try again
          </button>
          <button type="button" onClick={() => void logout()} className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700">
            Logout
          </button>
        </div>
      </div>
    );
  }

  if (!lifecycle.data.panelUnlocked) {
    return (
      <Routes>
        <Route path="/seller/onboarding" element={<SellerOnboardingPage />} />
        <Route path="*" element={<Navigate to="/seller/onboarding" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/seller/login" element={<Navigate to="/seller" replace />} />
      <Route path="/seller/register" element={<Navigate to="/seller" replace />} />
      <Route path="/seller/onboarding" element={<Navigate to="/seller" replace />} />
      <Route element={<SellerLayout />}>
        <Route path="/seller" element={<SellerDashboardPage />} />
        <Route path="/seller/orders" element={<SellerOrdersPage />} />
        <Route path="/seller/products" element={<SellerProductsPage />} />
        <Route path="/seller/products/import" element={<SellerBulkImportPage />} />
        <Route path="/seller/products/import/:id" element={<SellerBulkImportPage />} />
        <Route path="/seller/products/imports" element={<SellerImportHistoryPage />} />
        <Route path="/seller/products/:id" element={<SellerProductDetailPage />} />
        <Route path="/seller/listings/:id" element={<SellerListingDetailPage />} />
        <Route path="/seller/inventory" element={<SellerInventoryPage />} />
        <Route path="/seller/categories" element={<SellerCategoriesPage />} />
        <Route path="/seller/subcategories" element={<Navigate to="/seller/categories" replace />} />
        <Route path="/seller/availability" element={<SellerAvailabilityPage />} />
        <Route path="/seller/earnings" element={<SellerEarningsPage />} />
        <Route path="/seller/settlements" element={<SellerSettlementsPage />} />
        <Route path="/seller/profile" element={<SellerProfilePage />} />
        <Route path="/seller/notifications" element={<SellerNotificationsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/seller" replace />} />
    </Routes>
  );
}

/** Live counts for nav badges — the same cached queries the pages use. */
function useNavBadges(): Record<Badge, number> {
  const summary = useSellerOrderSummary();
  const unread = useNotificationUnreadCount(useSellerNotificationSource());
  return { orders: summary.data?.counts.NEW ?? 0, notifications: unread.data ?? 0 };
}

function CountBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger-500 px-1.5 text-[11px] font-bold leading-none text-white">
      {formatUnreadBadge(count)}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

function SellerSidebar({
  collapsed,
  onNavigate,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onNavigate: () => void;
  onToggleCollapsed?: () => void;
}) {
  const availability = useSellerAvailability();
  const nav = useNav();
  const logout = useSellerAuth((state) => state.logout);
  const user = useSellerAuth((state) => state.user);
  const badges = useNavBadges();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className={`flex items-center gap-2 py-5 ${collapsed ? 'justify-center px-2' : 'justify-between px-5'}`}>
        {collapsed ? (
          <span className="text-xl font-bold text-brand-500" aria-label="Aadione Seller Panel" role="img">
            A
          </span>
        ) : (
          <div>
            <AadioneWordmark className="text-2xl" />
            <p className="mt-1 text-xs font-medium text-gray-500">Seller Panel</p>
          </div>
        )}
        {onToggleCollapsed && !collapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            className="rounded-lg p-2 text-gray-400 outline-none transition hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <Icon name="chevronLeft" className="h-4 w-4" />
          </button>
        )}
      </div>
      {onToggleCollapsed && collapsed && (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
          className="mx-auto mb-2 rounded-lg p-2 text-gray-400 outline-none transition hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-brand-400"
        >
          <Icon name="chevronRight" className="h-4 w-4" />
        </button>
      )}

      <nav aria-label="Seller Panel" className={`flex-1 space-y-3 overflow-y-auto pb-2 ${collapsed ? 'px-2' : 'px-3'}`}>
        {SECTIONS.map((section) => (
          <div key={section.key} className={collapsed ? 'space-y-1 border-t border-gray-100 pt-2 first:border-0 first:pt-0' : 'space-y-1'}>
            {!collapsed && <p className="px-3 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{section.label}</p>}
            {nav.filter((item) => item.section === section.key).map((item) => {
              const count = item.badge ? badges[item.badge] : 0;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    `relative flex min-h-11 items-center gap-3 rounded-xl text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-brand-400 ${
                      collapsed ? 'justify-center px-2' : 'px-3 py-2.5'
                    } ${isActive ? 'bg-brand-50 text-brand-600' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`
                  }
                >
                  <Icon name={item.icon} />
                  {!collapsed && item.label}
                  {collapsed ? (
                    count > 0 && <span aria-hidden="true" className="absolute right-2 top-2 h-2 w-2 rounded-full bg-danger-500" />
                  ) : (
                    <CountBadge count={count} label={item.badge === 'orders' ? 'new orders' : 'unread'} />
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      <div className={`space-y-2 border-t border-gray-100 ${collapsed ? 'p-2' : 'p-3'}`}>
        {!collapsed && (
          <div className="flex items-center gap-3 rounded-xl bg-gray-50 px-3 py-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <Icon name="store" className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-gray-900">
                {availability.data?.sellerName ?? (availability.isPending ? '…' : 'Your store')}
              </p>
              <p className="truncate text-xs text-gray-500">{user?.fullName ?? user?.mobile ?? ''}</p>
            </div>
          </div>
        )}
        <button
          type="button"
          disabled={signingOut}
          title={collapsed ? 'Logout' : undefined}
          aria-label={collapsed ? 'Logout' : undefined}
          onClick={() => {
            setSigningOut(true);
            void logout().finally(() => setSigningOut(false));
          }}
          className={`flex min-h-11 w-full items-center gap-3 rounded-xl text-sm font-medium text-gray-600 outline-none transition hover:bg-gray-50 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-50 ${
            collapsed ? 'justify-center px-2' : 'px-3 py-2.5'
          }`}
        >
          <Icon name="lock" />
          {!collapsed && (signingOut ? 'Signing out…' : 'Logout')}
        </button>
      </div>
    </div>
  );
}

/** Shown until the seller replaces the temporary password Aadione issued. */
function TemporaryPasswordBanner() {
  const mustChange = useSellerAuth((state) => state.password?.passwordChangeRequired === true);
  if (!mustChange) return null;
  return (
    <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 sm:px-6">
      You are signed in with a temporary password from Aadione.{' '}
      <NavLink to="/seller/profile" className="font-semibold underline">
        Change your password
      </NavLink>
    </div>
  );
}

function SellerLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { pathname } = useLocation();
  const notificationSource = useSellerNotificationSource();
  // The longest matching entry names the page (detail pages take their section's name).
  const nav = useNav();
  const title = ([...nav].sort((a, b) => b.to.length - a.to.length).find((item) =>
    item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
  ) ?? (pathname.startsWith('/seller/listings') ? nav.find((item) => item.to === '/seller/products') : nav[0]))!.label;

  // The drawer closes on navigation and on Escape.
  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const toggleCollapsed = () =>
    setCollapsed((value) => {
      writeCollapsed(!value);
      return !value;
    });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Permanent rail from lg up (collapsible); slide-over below it. */}
      <aside className={`fixed inset-y-0 left-0 hidden border-r border-gray-200 transition-[width] lg:block ${collapsed ? 'w-[4.5rem]' : 'w-60'}`}>
        <SellerSidebar collapsed={collapsed} onNavigate={() => undefined} onToggleCollapsed={toggleCollapsed} />
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-gray-900/40"
            onClick={() => setNavOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-64 max-w-[85vw] border-r border-gray-200 shadow-xl">
            <SellerSidebar collapsed={false} onNavigate={() => setNavOpen(false)} />
          </aside>
        </div>
      )}

      <div className={collapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-60'}>
        <header className="sticky top-0 z-30 border-b border-gray-200 bg-white">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6 sm:py-3.5">
            <button
              onClick={() => setNavOpen(true)}
              aria-label="Open navigation"
              aria-expanded={navOpen}
              className="rounded-lg p-2 text-gray-500 outline-none transition hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-brand-400 lg:hidden"
            >
              <Icon name="menu" />
            </button>
            <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-gray-900 sm:text-xl">{title}</h1>
            <NotificationBell source={notificationSource} />
          </div>
          <TemporaryPasswordBanner />
        </header>
        {/* Bottom padding on phones keeps content clear of the tab bar. */}
        <main className="mx-auto max-w-6xl px-3 pb-24 pt-4 sm:px-6 sm:pt-6 lg:pb-8">
          <Outlet />
        </main>
      </div>

      <BottomTabs onMore={() => setNavOpen(true)} />
      <ToastRegion />
    </div>
  );
}

/** Fixed tab bar below lg — thumb-reachable navigation on phones. */
function BottomTabs({ onMore }: { onMore: () => void }) {
  const { pathname } = useLocation();
  const badges = useNavBadges();
  const inTabs = TABS.some((tab) => (tab.end ? pathname === tab.to : pathname.startsWith(tab.to)));
  const item =
    'relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold outline-none transition focus-visible:bg-brand-50';
  return (
    <nav
      aria-label="Seller navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <div className="mx-auto flex max-w-lg">
        {TABS.map((tab) => {
          const count = tab.badge ? badges[tab.badge] : 0;
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) => `${item} ${isActive ? 'text-brand-600' : 'text-gray-500'}`}
            >
              <Icon name={tab.icon} className="h-6 w-6" />
              {tab.label}
              {count > 0 && (
                <span className="absolute left-1/2 top-1.5 ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-500 px-1 text-[10px] font-bold leading-none text-white">
                  {formatUnreadBadge(count)}
                  <span className="sr-only"> new</span>
                </span>
              )}
            </NavLink>
          );
        })}
        <button type="button" onClick={onMore} className={`${item} ${inTabs ? 'text-gray-500' : 'text-brand-600'}`}>
          <Icon name="menu" className="h-6 w-6" />
          More
        </button>
      </div>
    </nav>
  );
}
