import type { QueryClient } from "@tanstack/react-query";
import { Link, Navigate, Outlet, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";
import { useAuth } from "@/auth/auth";
import { rolesForPath } from "@/auth/access";
import { AppShell } from "@/components/crm/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";

const PUBLIC_PATHS = ["/login"];

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    <>
      <Guarded />
      <Toaster richColors position="top-right" />
    </>
  );
}

function Guarded() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { status, profile, roles } = useAuth();

  if (PUBLIC_PATHS.includes(path)) {
    if (status === "authenticated" && profile) return <Navigate to={profile.home_route} replace />;
    return <Outlet />;
  }
  if (status === "anonymous") return <Navigate to="/login" search={path === "/" ? {} : { redirect: path }} replace />;
  if (status === "loading" || !profile)
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground" aria-busy="true">
        Loading your workspace…
      </div>
    );
  if (profile.user.must_change_password && path !== "/change-password") return <Navigate to="/change-password" replace />;
  if (path === "/change-password") return <Outlet />;

  const needed = rolesForPath(path);
  const permitted = !needed || needed.some((r) => roles.includes(r));
  return <AppShell>{permitted ? <Outlet /> : <AccessDenied />}</AppShell>;
}

export function AccessDenied() {
  const { profile } = useAuth();
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">You don't have access to this screen</h1>
      <p className="mt-2 text-sm text-muted-foreground">Your role doesn't include this area. Ask an administrator if you need access.</p>
      <Button className="mt-6" asChild>
        <Link to={profile?.home_route ?? "/dashboard"}>Go to my home screen</Link>
      </Button>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-5xl font-bold">404</h1>
      <p className="mt-3 text-sm text-muted-foreground">This page doesn't exist or has moved.</p>
      <Button className="mt-6" asChild>
        <Link to="/">Go home</Link>
      </Button>
    </div>
  );
}
